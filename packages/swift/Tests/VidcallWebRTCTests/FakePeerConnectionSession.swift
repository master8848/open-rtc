//
//  FakePeerConnectionSession.swift
//  VidcallWebRTCTests
//
//  In-memory `PeerConnectionSession` / `DataChannelSession` fakes for the
//  offline state-machine (L1) and in-process loopback (L2) tests. The fakes
//  implement the same signaling-state transitions as a real peer connection
//  (offer/answer/rollback, trickle candidates, data channel adoption) so the
//  negotiation logic under test behaves exactly as it will against
//  GoogleWebRTC.
//

import Foundation
import Vidcall
@testable import VidcallWebRTC

// MARK: - Fake data channel

final class FakeDataChannel: DataChannelSession {
    let label: String
    private(set) var readyState: DataChannelState = .connecting
    private(set) var bufferedAmount: UInt64 = 0
    private(set) var sent: [Data] = []
    /// `isBinary` flag of each accepted send (parallel to `sent`).
    private(set) var sentBinary: [Bool] = []
    private(set) var closed = false

    /// Called for every successful send — the delivery pipe to the peer.
    var onSend: ((Data) -> Void)?
    /// When set, sends fail (simulates a broken channel).
    var rejectSends = false

    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?
    var onMessage: ((Data) -> Void)?
    var onBufferedAmountChange: ((UInt64) -> Void)?

    init(label: String) {
        self.label = label
    }

    @discardableResult
    func sendData(_ data: Data, isBinary: Bool = false) -> Bool {
        guard readyState == .open, !rejectSends else { return false }
        sent.append(data)
        sentBinary.append(isBinary)
        bufferedAmount += UInt64(data.count)
        onBufferedAmountChange?(bufferedAmount)
        onSend?(data)
        bufferedAmount = 0
        onBufferedAmountChange?(0)
        return true
    }

    /// Simulates the platform reporting a `bufferedAmount` change (without a
    /// send) — used to exercise the bus's bufferedAmount plumbing.
    func simulateBufferedAmountChange(_ amount: UInt64) {
        bufferedAmount = amount
        onBufferedAmountChange?(amount)
    }

    /// Simulates the SCTP handshake completing.
    func open() {
        readyState = .open
        onOpen?()
    }

    func close() {
        guard !closed else { return }
        closed = true
        readyState = .closed
        onClose?()
    }

    /// Delivers an inbound frame (called by the peer's `onSend` pipe).
    func deliver(_ data: Data) {
        onMessage?(data)
    }
}

// MARK: - Fake peer connection session

final class FakePeerConnectionSession: PeerConnectionSession {
    // Observability for assertions
    private(set) var appliedLocal: [SessionDescription] = []
    private(set) var appliedRemote: [SessionDescription] = []
    private(set) var addedCandidates: [IceCandidate] = []
    private(set) var createdOffers: [SessionDescription] = []
    private(set) var createdAnswers: [SessionDescription] = []
    private(set) var iceRestartRequested = false
    private(set) var dataChannels: [FakeDataChannel] = []
    private(set) var closed = false

    /// When true, `setLocalDescription(.offer)` emits a trickle candidate
    /// (simulates ICE gathering).
    var shouldGatherCandidates = false
    /// When set, applying a remote offer creates a remote data channel with
    /// this label and fires `onDataChannel` (simulates `ondatachannel`).
    var remoteChannelLabels: [String] = []
    /// Optional hook invoked at the start of `setRemoteDescription(.offer)`
    /// (used by the loopback pair to wire the SCTP pipe between two fakes).
    var onBeforeApplyRemoteOffer: (() -> Void)?
    /// Fails `addIceCandidate` when set (simulates InvalidStateError races).
    var failAddIceCandidate = false

    var signalingState: PeerSignalingState = .stable
    var remoteDescriptionIsSet: Bool { appliedRemote.isEmpty == false }

    var onLocalIceCandidate: ((IceCandidate) -> Void)?
    var onDataChannel: ((DataChannelSession) -> Void)?
    var onNegotiationNeeded: (() -> Void)?
    var onConnectionStateChange: ((PeerConnectionState) -> Void)?

    private var offerCounter = 0

    // MARK: PeerConnectionSession

    func createOffer(iceRestart: Bool) async throws -> SessionDescription {
        if iceRestart { iceRestartRequested = true }
        offerCounter += 1
        let sdp = "v=0\r\no=- \(offerCounter) \(iceRestart ? 2 : 1) IN IP4 127.0.0.1\r\ns=-\r\nt=0 0"
        let description = SessionDescription(type: .offer, sdp: sdp)
        createdOffers.append(description)
        return description
    }

    func createAnswer() async throws -> SessionDescription {
        let sdp = "v=0\r\no=- 99 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0"
        let description = SessionDescription(type: .answer, sdp: sdp)
        createdAnswers.append(description)
        return description
    }

    func setLocalDescription(_ description: SessionDescription) async throws {
        appliedLocal.append(description)
        switch description.type {
        case .offer:
            precondition(signalingState == .stable, "offer while \(signalingState)")
            signalingState = .haveLocalOffer
            if shouldGatherCandidates {
                emitTrickleCandidates()
            }
        case .answer:
            precondition(signalingState == .haveRemoteOffer, "answer while \(signalingState)")
            signalingState = .stable
            if shouldGatherCandidates {
                emitTrickleCandidates()
            }
        case .rollback:
            precondition(signalingState == .haveLocalOffer, "rollback while \(signalingState)")
            signalingState = .stable
        }
    }

    func setRemoteDescription(_ description: SessionDescription) async throws {
        appliedRemote.append(description)
        switch description.type {
        case .offer:
            precondition(signalingState == .stable, "remote offer while \(signalingState)")
            signalingState = .haveRemoteOffer
            // Simulate `ondatachannel` for channels negotiated in the offer.
            if let hook = onBeforeApplyRemoteOffer {
                hook()
            } else {
                for label in remoteChannelLabels {
                    let channel = FakeDataChannel(label: label)
                    onDataChannel?(channel)
                }
            }
        case .answer:
            precondition(signalingState == .haveLocalOffer, "remote answer while \(signalingState)")
            signalingState = .stable
        case .rollback:
            fatalError("rollback is a local description operation")
        }
    }

    func addIceCandidate(_ candidate: IceCandidate) async throws {
        if failAddIceCandidate {
            throw VidcallError.invalidMessage("addIceCandidate failed (fake)")
        }
        addedCandidates.append(candidate)
    }

    func createDataChannel(label: String) -> DataChannelSession? {
        let channel = FakeDataChannel(label: label)
        dataChannels.append(channel)
        return channel
    }

    func close() {
        guard !closed else { return }
        closed = true
        signalingState = .closed
        onConnectionStateChange?(.closed)
    }

    // MARK: Helpers

    func fireConnectionState(_ state: PeerConnectionState) {
        onConnectionStateChange?(state)
    }

    func fireLocalCandidate(_ candidate: IceCandidate) {
        onLocalIceCandidate?(candidate)
    }

    private func emitTrickleCandidates() {
        onLocalIceCandidate?(IceCandidate(
            sdp: "candidate:1 1 udp 2122260223 127.0.0.1 51000 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0
        ))
    }
}

// MARK: - Capturing signaling (state-machine tests)

/// Records every outbound signal; the test asserts on them.
final class CapturingSignaling: PeerSignaling, @unchecked Sendable {
    private(set) var offers: [OfferPayload] = []
    private(set) var answers: [OfferPayload] = []
    private(set) var ice: [IcePayload] = []
    private(set) var sendErrors: [Error] = []
    var failSends = false

    func sendOffer(_ payload: OfferPayload) throws {
        if failSends { throw VidcallError.notConnected }
        offers.append(payload)
    }

    func sendAnswer(_ payload: OfferPayload) throws {
        if failSends { throw VidcallError.notConnected }
        answers.append(payload)
    }

    func sendIce(_ payload: IcePayload) throws {
        if failSends { throw VidcallError.notConnected }
        ice.append(payload)
    }
}

// MARK: - In-process signaling bridge (L2 loopback)

enum BridgedSignal {
    case offer(OfferPayload)
    case answer(OfferPayload)
    case ice(IcePayload)
}

/// Routes signals between two in-process peers (no network): each endpoint
/// enqueues for the other side, and `processAll` delivers FIFO with real
/// async handling, so offer → answer → ICE causality is preserved.
final class SignalingBridge {
    private let lock = NSLock()
    private var queue: [(recipient: Bool, signal: BridgedSignal)] = [] // recipient: true = A, false = B
    private(set) var failures: [Error] = []
    var managerA: PeerConnectionManager?
    var managerB: PeerConnectionManager?

    /// True when no signals are pending delivery.
    var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return queue.isEmpty
    }

    /// A signaling endpoint for side `isA`.
    func endpoint(isA: Bool) -> PeerSignaling {
        BridgeEndpoint(bridge: self, isA: isA)
    }

    func enqueue(toA: Bool, _ signal: BridgedSignal) {
        lock.lock()
        queue.append((toA, signal))
        lock.unlock()
    }

    /// Delivers all pending signals in FIFO order. Returns after the queue is
    /// empty (new signals enqueued during delivery are drained too).
    func processAll() async throws {
        while let next = takeNext() {
            let (toA, signal) = next
            let manager = toA ? managerA : managerB
            guard let manager else { continue }
            do {
                switch signal {
                case .offer(let payload):
                    try await manager.receiveRemoteOffer(payload)
                case .answer(let payload):
                    try await manager.receiveRemoteAnswer(payload)
                case .ice(let payload):
                    try manager.addRemoteIceCandidate(payload)
                }
            } catch {
                failures.append(error)
            }
        }
    }

    private func takeNext() -> (Bool, BridgedSignal)? {
        lock.lock()
        defer { lock.unlock() }
        guard !queue.isEmpty else { return nil }
        return queue.removeFirst()
    }
}

private final class BridgeEndpoint: PeerSignaling, @unchecked Sendable {
    let bridge: SignalingBridge
    let isA: Bool

    init(bridge: SignalingBridge, isA: Bool) {
        self.bridge = bridge
        self.isA = isA
    }

    func sendOffer(_ payload: OfferPayload) throws {
        bridge.enqueue(toA: !isA, .offer(payload))
    }

    func sendAnswer(_ payload: OfferPayload) throws {
        bridge.enqueue(toA: !isA, .answer(payload))
    }

    func sendIce(_ payload: IcePayload) throws {
        bridge.enqueue(toA: !isA, .ice(payload))
    }
}

// MARK: - Wire the fake sessions into a loopback pair

/// A pair of fake sessions wired like two real peers: A's local data channel
/// delivers into B's adopted remote channel and vice versa.
final class LoopbackPair {
    let sessionA = FakePeerConnectionSession()
    let sessionB = FakePeerConnectionSession()
    private(set) var channelA: FakeDataChannel?
    private(set) var channelB: FakeDataChannel?

    /// Links A's first local data channel to a remote channel on B: when B
    /// applies the first remote offer, a remote channel is created, the SCTP
    /// pipe is wired both ways, and `ondatachannel` fires on B. Call once
    /// before the first offer crosses the bridge.
    func wireDataChannels() {
        sessionB.onBeforeApplyRemoteOffer = { [weak self] in
            guard let self, let local = self.sessionA.dataChannels.first else { return }
            let remote = FakeDataChannel(label: local.label)
            self.channelA = local
            self.channelB = remote
            local.onSend = { data in remote.deliver(data) }
            remote.onSend = { data in local.deliver(data) }
            self.sessionB.onDataChannel?(remote)
        }
    }

    /// Simulates the SCTP channels opening on both sides.
    func openChannels() {
        channelA?.open()
        channelB?.open()
    }
}


// MARK: - Sendable capture box (tests)

/// A tiny thread-safe capture box so `@Sendable` bus callbacks can hand
/// values back to the test without Swift-6 `SendableClosureCaptures` warnings.
final class ValueBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T?

    var value: T? {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }

    func set(_ value: T?) {
        lock.lock()
        _value = value
        lock.unlock()
    }
}
