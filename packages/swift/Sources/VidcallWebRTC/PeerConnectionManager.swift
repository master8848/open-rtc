//
//  PeerConnectionManager.swift
//  VidcallWebRTC
//
//  Peer connection + offer/answer/ICE wired to the vidcall signaling protocol
//  (protocol/schema.json). SDP (`OfferPayload`) and ICE (`IcePayload`) are
//  relayed verbatim — the signaling layer never parses or transforms them.
//
//  The negotiation state machine implements the "perfect negotiation" pattern
//  (same as packages/core/src/peer-connection-manager.ts):
//
//  - **Glare**: on a colliding remote offer, the polite peer rolls back its
//    own *local* offer (`setLocalDescription(.rollback)`) and accepts the
//    remote one; the impolite peer ignores the colliding remote offer.
//  - **Trickle ICE (RFC 8838)**: local candidates are signaled as they fire;
//    remote candidates are queued until the matching remote description has
//    been applied, then flushed (spec requires `addIceCandidate` after
//    `setRemoteDescription`).
//  - **ICE restart (RFC 8445 §9)**: `restartIce()` triggers a fresh offer
//    with new ICE credentials; `autoRestartIce` does the same automatically
//    when `iceConnectionState` turns `failed`.
//  - **Data channels**: the bus creates the local channel (included in the
//    next offer); a remote channel delivered via `onDataChannel` is adopted
//    and becomes active (mirrors the TS `DataChannelBus`).
//
//  The manager is WebRTC-agnostic — it drives a `PeerConnectionSession`
//  (real adapter: `RTCPeerConnectionSession`; tests inject fakes).
//

import Foundation
import Vidcall

/// Outbound signaling hook: the manager emits offer/answer/ice wire payloads.
/// The real implementation wraps `VidcallClient`; tests use an in-process
/// signaling bridge.
public protocol PeerSignaling: AnyObject, Sendable {
    func sendOffer(_ payload: OfferPayload) throws
    func sendAnswer(_ payload: OfferPayload) throws
    func sendIce(_ payload: IcePayload) throws
}

/// Connection status of the underlying peer connection.
public enum PeerConnectionStatus: Equatable, Sendable {
    case idle
    case connecting
    case connected
    case disconnected
    case failed(String)
}

/// WebRTC-agnostic surface of the peer-connection manager. `VidcallClient`
/// events are fed through `handleIncoming(event:)`; SDP/ICE flow back out via
/// the `PeerSignaling` hook.
public protocol PeerConnectionManaging: AnyObject, Sendable {
    /// Feeds a decoded client event into the negotiation state machine.
    func handleIncoming(event: VidcallClient.Event)
    /// Applies a remote trickle ICE candidate (type `ice`).
    func addRemoteIceCandidate(_ payload: IcePayload) throws
    /// Ensures an offer/answer exchange (perfect negotiation).
    func negotiate() async throws
    /// Restarts ICE with fresh credentials (RFC 8445 §9).
    func restartIce() async throws
    /// The per-connection typed data-channel bus (created eagerly so the
    /// local data channel is part of the first offer).
    var dataChannelBus: DataChannelBus? { get }
    /// Closes the peer connection and removes this manager from the client.
    func leave()
}

/// Concrete peer-connection manager: the negotiation state machine over a
/// `PeerConnectionSession`. Create the real WebRTC-backed instance via
/// `VidcallWebRTC.makePeerConnectionManager`; tests construct it directly
/// with a fake session and an in-process signaling bridge.
public final class PeerConnectionManager: PeerConnectionManaging, @unchecked Sendable {
    /// Stream id used for local media tracks.
    public static let localStreamId = "vidcall-stream"
    /// Default data-channel label (matches the TS core `'vidcall'`).
    public static let defaultDataChannelName = "vidcall"

    // MARK: Callbacks

    /// A local SDP offer is ready — forward via `sendOffer` (already emitted
    /// through `signaling`; use for observability/relay).
    public var onLocalOffer: (@Sendable (OfferPayload) -> Void)?
    /// A local SDP answer is ready.
    public var onLocalAnswer: (@Sendable (OfferPayload) -> Void)?
    /// A local trickle ICE candidate is ready.
    public var onLocalIceCandidate: (@Sendable (IcePayload) -> Void)?
    /// Status changes of the peer connection.
    public var onStatusChange: (@Sendable (PeerConnectionStatus) -> Void)?

    // MARK: Public state

    /// The session (real or fake) this manager drives.
    public let session: PeerConnectionSession
    /// Effective configuration.
    public let configuration: PeerConnectionConfiguration
    /// Outbound signaling hook.
    public let signaling: PeerSignaling
    /// Optional remote peer id — when set, only envelopes from this sender are
    /// accepted (single-peer safety against broadcast backends).
    public let remotePeerId: String?

    /// Current status.
    public private(set) var status: PeerConnectionStatus = .idle {
        didSet {
            guard oldValue != status else { return }
            onStatusChange?(status)
        }
    }

    // MARK: Private state

    private let lock = NSLock()

    /// Runs `body` while holding the state lock. All mutable manager state is
    /// accessed through this helper so the async negotiation paths never call
    /// `NSLock` methods directly (Swift 6 concurrency safety).
    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private var makingOffer = false
    private var ignoreRemoteOffer = false
    private var restartingIce = false
    private var closed = false
    private var pendingIceCandidates: [IceCandidate] = []
    private var _dataChannelBus: DataChannelBus?

    // MARK: Init

    /// Wires the manager to `session` and registers the session callbacks.
    public init(
        session: PeerConnectionSession,
        configuration: PeerConnectionConfiguration,
        signaling: PeerSignaling,
        remotePeerId: String? = nil
    ) {
        self.session = session
        self.configuration = configuration
        self.signaling = signaling
        self.remotePeerId = remotePeerId
        session.onLocalIceCandidate = { [weak self] candidate in
            self?.handleLocalIceCandidate(candidate)
        }
        session.onDataChannel = { [weak self] channel in
            self?.handleRemoteDataChannel(channel)
        }
        session.onNegotiationNeeded = { [weak self] in
            self?.negotiationNeeded()
        }
        session.onConnectionStateChange = { [weak self] state in
            self?.handleConnectionState(state)
        }
        // The bus is created eagerly so the local data channel exists before
        // the first offer (it is part of the negotiated SCTP setup — same as
        // the TS core, whose `Room` creates the bus at construction).
        _dataChannelBus = DataChannelBus(session: session, name: PeerConnectionManager.defaultDataChannelName)
    }

    deinit {
        session.close()
    }

    // MARK: PeerConnectionManaging

    public func handleIncoming(event: VidcallClient.Event) {
        switch event {
        case .offer(let envelope, let payload):
            guard accepts(senderId: envelope.senderId) else { return }
            Task { [weak self] in
                do {
                    try await self?.receiveRemoteOffer(payload)
                } catch {
                    self?.status = .failed(error.localizedDescription)
                }
            }
        case .answer(let envelope, let payload):
            guard accepts(senderId: envelope.senderId) else { return }
            Task { [weak self] in
                do {
                    try await self?.receiveRemoteAnswer(payload)
                } catch {
                    self?.status = .failed(error.localizedDescription)
                }
            }
        case .ice(let envelope, let payload):
            guard accepts(senderId: envelope.senderId) else { return }
            do {
                try addRemoteIceCandidate(payload)
            } catch {
                status = .failed(error.localizedDescription)
            }
        default:
            break
        }
    }

    public func addRemoteIceCandidate(_ payload: IcePayload) throws {
        guard !withLock({ closed }) else { return }
        let candidate = IceCandidate(
            sdp: payload.candidate,
            sdpMid: payload.sdpMid,
            sdpMLineIndex: Int32(payload.sdpMLineIndex ?? 0)
        )
        if session.remoteDescriptionIsSet {
            addCandidate(candidate)
        } else {
            // Trickle: queue until the remote description lands (RFC 8838).
            withLock {
                pendingIceCandidates.append(candidate)
            }
        }
    }

    public func negotiate() async throws {
        try await negotiate(iceRestart: false)
    }

    /// Restarts ICE: a new offer with fresh ufrag/pwd is negotiated (RFC 8445
    /// §9), i.e. `negotiate()` with the stack's ICE-restart path enabled
    /// (`RTCPeerConnection.restartIce()` + `IceRestart` constraints in the
    /// real adapter; fakes implement `createOffer(iceRestart:)` directly).
    public func restartIce() async throws {
        let proceed = withLock { () -> Bool in
            guard !closed, !restartingIce else { return false }
            restartingIce = true
            return true
        }
        guard proceed else { return }
        defer {
            withLock { restartingIce = false }
        }
        try await negotiate(iceRestart: true)
    }

    /// Core negotiation. Guards against overlapping offers; the local data
    /// channel is created before the offer so it is part of the SCTP setup.
    private func negotiate(iceRestart: Bool) async throws {
        let proceed = withLock { () -> Bool in
            guard !closed, !makingOffer else { return false }
            makingOffer = true
            return true
        }
        guard proceed else { return }
        defer {
            withLock { makingOffer = false }
        }

        // The local data channel must exist before the offer so it is part of
        // the negotiated SCTP setup (mirrors the TS bus).
        ensureDataChannelBus()

        let offer = try await session.createOffer(iceRestart: iceRestart)
        try await session.setLocalDescription(offer)
        let payload = OfferPayload(sdp: offer.sdp, label: iceRestart ? "ice-restart" : "main")
        onLocalOffer?(payload)
        try signaling.sendOffer(payload)
    }

    /// The typed data-channel bus for this peer (created eagerly in `init`).
    public var dataChannelBus: DataChannelBus? {
        withLock { _dataChannelBus }
    }

    public func leave() {
        withLock {
            guard !closed else { return }
            closed = true
        }
        session.close()
        withLock { pendingIceCandidates.removeAll() }
        status = .disconnected
    }

    // MARK: Remote signaling

    // Internal (not private) so in-process signaling bridges / tests can
    // drive the state machine directly and await completion.

    func receiveRemoteOffer(_ payload: OfferPayload) async throws {
        guard !withLock({ closed }) else { return }
        let sdp = SessionDescription(type: .offer, sdp: payload.sdp)

        let collision = withLock {
            makingOffer || session.signalingState != .stable
        }

        if collision {
            if !configuration.polite {
                // Impolite side: ignore the colliding remote offer (perfect
                // negotiation). The remote side will roll back and answer ours.
                withLock { ignoreRemoteOffer = true }
                return
            }
            // Polite side: back out of our own in-flight offer, then accept
            // theirs. Rollback is a LOCAL description operation (W3C
            // `RTCSdpType.rollback`); it is a no-op if our local offer has
            // not landed yet (mid-`createOffer` glare race).
            if session.signalingState == .haveLocalOffer {
                try await session.setLocalDescription(SessionDescription(type: .rollback, sdp: ""))
            }
        }

        try await session.setRemoteDescription(sdp)
        if session.signalingState == .haveRemoteOffer {
            let answer = try await session.createAnswer()
            try await session.setLocalDescription(answer)
            let answerPayload = OfferPayload(sdp: answer.sdp, label: payload.label)
            onLocalAnswer?(answerPayload)
            try signaling.sendAnswer(answerPayload)
        }
        await flushPendingIceCandidates()
    }

    func receiveRemoteAnswer(_ payload: OfferPayload) async throws {
        guard !withLock({ closed }) else { return }
        let sdp = SessionDescription(type: .answer, sdp: payload.sdp)
        try await session.setRemoteDescription(sdp)
        withLock { ignoreRemoteOffer = false }
        await flushPendingIceCandidates()
    }

    // MARK: Data channels

    /// Ensures the bus exists (idempotent). The bus is created eagerly in
    /// `init`, so this is a safety no-op in practice.
    private func ensureDataChannelBus() {
        withLock {
            if _dataChannelBus == nil {
                _dataChannelBus = DataChannelBus(session: session, name: PeerConnectionManager.defaultDataChannelName)
            }
        }
    }

    /// A remote data channel arrived (`ondatachannel`, answerer side): adopt
    /// it into the bus. The remote channel becomes active (only the offerer's
    /// channel is actually negotiated on the wire).
    private func handleRemoteDataChannel(_ channel: DataChannelSession) {
        withLock { _dataChannelBus }?.adoptRemote(channel)
    }

    // MARK: ICE + status plumbing

    private func handleLocalIceCandidate(_ candidate: IceCandidate) {
        let payload = IcePayload(
            candidate: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: Int(candidate.sdpMLineIndex)
        )
        onLocalIceCandidate?(payload)
        try? signaling.sendIce(payload)
    }

    /// Applies one remote candidate on the session (fire-and-forget for the
    /// immediate path; the returned task is awaited by the queue flush so the
    /// state machine is deterministic, mirroring the TS core).
    @discardableResult
    private func addCandidate(_ candidate: IceCandidate) -> Task<Void, Never> {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.session.addIceCandidate(candidate)
            } catch {
                // The remote description changed under us (e.g. renegotiation)
                // or the candidate raced an ignored offer: re-queue it; it is
                // retried on the next flush.
                withLock {
                    guard !self.ignoreRemoteOffer else { return }
                    self.pendingIceCandidates.append(candidate)
                }
            }
        }
    }

    /// Applies all queued trickle candidates. Called after a remote
    /// description lands; awaits each add so callers observe a settled state.
    private func flushPendingIceCandidates() async {
        guard session.remoteDescriptionIsSet else { return }
        let queued = withLock { () -> [IceCandidate] in
            let queued = pendingIceCandidates
            pendingIceCandidates.removeAll()
            return queued
        }
        for candidate in queued {
            await addCandidate(candidate).value
        }
    }

    private func negotiationNeeded() {
        Task { [weak self] in
            try? await self?.negotiate()
        }
    }

    private func handleConnectionState(_ state: PeerConnectionState) {
        switch state {
        case .connected:
            status = .connected
        case .failed:
            status = .failed("ICE connection failed")
            if configuration.autoRestartIce {
                Task { [weak self] in
                    try? await self?.restartIce()
                }
            }
        case .disconnected, .closed:
            status = .disconnected
        default:
            status = .connecting
        }
    }

    private func accepts(senderId: String) -> Bool {
        guard let expected = remotePeerId else { return true }
        return senderId == expected
    }
}
