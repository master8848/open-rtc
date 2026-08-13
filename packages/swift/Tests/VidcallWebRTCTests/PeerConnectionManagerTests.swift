//
//  PeerConnectionManagerTests.swift
//  VidcallWebRTCTests
//
//  Offline state-machine tests for PeerConnectionManager (WebRTC-agnostic,
//  driven with injected fake sessions + capturing signaling):
//
//  - perfect negotiation: offer/answer, glare (polite local rollback vs
//    impolite ignore), renegotiation
//  - trickle ICE: candidates before the remote description are queued and
//    flushed after setRemoteDescription
//  - ICE restart: fresh offer with iceRestart, auto-restart on `failed`
//  - data channels: local channel created before the offer, remote channel
//    adopted into the bus
//  - single-peer safety: remotePeerId filters foreign senders
//

import XCTest
import Vidcall
@testable import VidcallWebRTC

final class PeerConnectionManagerTests: XCTestCase {
    private func makeManager(
        session: FakePeerConnectionSession = FakePeerConnectionSession(),
        configuration: PeerConnectionConfiguration = PeerConnectionConfiguration(polite: true),
        signaling: CapturingSignaling = CapturingSignaling(),
        remotePeerId: String? = nil
    ) -> (PeerConnectionManager, FakePeerConnectionSession, CapturingSignaling) {
        let manager = PeerConnectionManager(
            session: session,
            configuration: configuration,
            signaling: signaling,
            remotePeerId: remotePeerId
        )
        return (manager, session, signaling)
    }

    // MARK: Offer / answer

    func testNegotiateCreatesOfferAndSignalsIt() async throws {
        let (manager, session, signaling) = makeManager()
        try await manager.negotiate()

        XCTAssertEqual(session.createdOffers.count, 1)
        XCTAssertEqual(session.appliedLocal.map(\.type), [.offer])
        XCTAssertEqual(session.signalingState, .haveLocalOffer)
        XCTAssertEqual(signaling.offers.count, 1)
        XCTAssertEqual(signaling.offers.first?.sdp, session.createdOffers.first?.sdp)
    }

    func testRemoteOfferProducesAnswer() async throws {
        let (manager, session, signaling) = makeManager()

        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))

        XCTAssertEqual(session.appliedRemote.map(\.type), [.offer])
        XCTAssertEqual(session.signalingState, .stable)
        XCTAssertEqual(session.createdAnswers.count, 1)
        XCTAssertEqual(signaling.answers.count, 1)
        XCTAssertEqual(signaling.answers.first?.sdp, session.createdAnswers.first?.sdp)
    }

    func testRemoteAnswerCompletesNegotiation() async throws {
        let (manager, session, _) = makeManager()
        try await manager.negotiate()
        XCTAssertEqual(session.signalingState, .haveLocalOffer)

        try await manager.receiveRemoteAnswer(OfferPayload(sdp: "remote-answer-sdp"))
        XCTAssertEqual(session.signalingState, .stable)
        XCTAssertEqual(session.appliedRemote.map(\.type), [.answer])
    }

    // MARK: Glare (perfect negotiation)

    /// Polite peer: a colliding remote offer rolls back its OWN LOCAL offer
    /// (review bug (a): rollback must apply to the local description), then
    /// accepts the remote offer and answers.
    func testGlarePoliteRollsBackLocalDescription() async throws {
        let (manager, session, signaling) = makeManager(configuration: PeerConnectionConfiguration(polite: true))
        session.shouldGatherCandidates = true

        // Both sides start negotiating at the same time: our offer is in flight.
        try await manager.negotiate()
        XCTAssertEqual(session.signalingState, .haveLocalOffer)

        // The remote offer collides with our in-flight offer.
        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))

        // Rollback must be applied to the LOCAL description, not the remote
        // one (review P0): offer -> rollback -> answer, all local; the only
        // remote description is the colliding offer.
        XCTAssertEqual(session.appliedLocal.map(\.type), [.offer, .rollback, .answer])
        XCTAssertEqual(session.appliedRemote.map(\.type), [.offer])
        XCTAssertEqual(session.signalingState, .stable)
        XCTAssertEqual(session.createdAnswers.count, 1)
        XCTAssertEqual(signaling.answers.count, 1)
    }

    /// Impolite peer: a colliding remote offer is ignored; our offer stands.
    func testGlareImpoliteIgnoresRemoteOffer() async throws {
        let (manager, session, _) = makeManager(configuration: PeerConnectionConfiguration(polite: false))
        try await manager.negotiate()
        XCTAssertEqual(session.signalingState, .haveLocalOffer)

        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))

        XCTAssertEqual(session.appliedRemote.count, 0, "impolite side must ignore the colliding offer")
        XCTAssertEqual(session.signalingState, .haveLocalOffer, "our offer stays in flight")
        XCTAssertEqual(session.createdAnswers.count, 0)
    }

    /// A remote offer with no collision is answered even by the impolite side.
    func testImpoliteAnswersWhenNoCollision() async throws {
        let (manager, session, signaling) = makeManager(configuration: PeerConnectionConfiguration(polite: false))
        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))
        XCTAssertEqual(session.createdAnswers.count, 1)
        XCTAssertEqual(signaling.answers.count, 1)
    }

    // MARK: Trickle ICE (review bug (b))

    /// Candidates arriving before the remote description must be queued, then
    /// applied after setRemoteDescription (RFC 8838).
    func testTrickleIceQueuedUntilRemoteDescription() async throws {
        let (manager, session, _) = makeManager()
        XCTAssertFalse(session.remoteDescriptionIsSet)

        // Candidate arrives before any remote description.
        let early = IcePayload(candidate: "candidate:early", sdpMid: "0", sdpMLineIndex: 0)
        try manager.addRemoteIceCandidate(early)
        XCTAssertEqual(session.addedCandidates.count, 0, "candidate must be queued, not dropped")

        // Remote offer lands → queue drains.
        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))
        await waitForCandidates(session, count: 1)
        XCTAssertEqual(session.addedCandidates.first?.sdp, "candidate:early")
    }

    /// Candidates arriving after the remote description apply immediately.
    func testTrickleIceAppliedImmediatelyAfterRemoteDescription() async throws {
        let (manager, session, _) = makeManager()
        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))

        let candidate = IcePayload(candidate: "candidate:late", sdpMid: "0", sdpMLineIndex: 0)
        try manager.addRemoteIceCandidate(candidate)
        await waitForCandidates(session, count: 1)
        XCTAssertEqual(session.addedCandidates.first?.sdp, "candidate:late")
    }

    /// A candidate that fails to apply (remote description changed) is
    /// re-queued and retried on the next flush (renegotiation).
    func testFailedCandidateIsRequeued() async throws {
        let (manager, session, _) = makeManager()
        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))
        XCTAssertEqual(session.signalingState, .stable)

        session.failAddIceCandidate = true
        try manager.addRemoteIceCandidate(IcePayload(candidate: "candidate:flaky", sdpMid: "0", sdpMLineIndex: 0))
        // allow the failing add to land and re-queue
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(session.addedCandidates.count, 0)

        // The next remote description (renegotiation) flushes the re-queued
        // candidate; the retry succeeds.
        session.failAddIceCandidate = false
        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-2"))
        await waitForCandidates(session, count: 1)
        XCTAssertEqual(session.addedCandidates.first?.sdp, "candidate:flaky")
    }

    // MARK: ICE restart (review bug (c))

    func testRestartIceProducesFreshOfferWithIceRestart() async throws {
        let (manager, session, signaling) = makeManager()
        // Converge on a negotiated connection first (restart is only valid
        // from a stable state on a real stack).
        try await manager.negotiate()
        try await manager.receiveRemoteAnswer(OfferPayload(sdp: "remote-answer-sdp"))
        XCTAssertEqual(session.signalingState, .stable)
        let firstOffer = signaling.offers.first?.sdp
        XCTAssertNotNil(firstOffer)

        try await manager.restartIce()

        XCTAssertTrue(session.iceRestartRequested)
        XCTAssertEqual(session.createdOffers.count, 2)
        XCTAssertEqual(signaling.offers.count, 2)
        XCTAssertNotEqual(signaling.offers.last?.sdp, firstOffer, "restart must produce a fresh offer")
    }

    func testAutoRestartIceOnFailedConnection() async throws {
        let (manager, session, signaling) = makeManager(
            configuration: PeerConnectionConfiguration(polite: true, autoRestartIce: true)
        )
        // Complete the initial negotiation first: ICE can only fail once a
        // connection was negotiated (and a second offer in `haveLocalOffer`
        // would be an InvalidStateError on a real stack).
        try await manager.negotiate()
        try await manager.receiveRemoteAnswer(OfferPayload(sdp: "remote-answer-sdp"))
        XCTAssertEqual(session.signalingState, .stable)

        session.fireConnectionState(.failed)
        // Let the auto-restart task run.
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(session.iceRestartRequested)
        XCTAssertEqual(signaling.offers.count, 2)
    }

    // MARK: Data channels

    func testDataChannelBusCreatedBeforeOffer() async throws {
        let (manager, session, _) = makeManager()
        try await manager.negotiate()

        XCTAssertEqual(session.dataChannels.count, 1, "local channel must exist before the offer")
        XCTAssertEqual(session.dataChannels.first?.label, "vidcall")
        XCTAssertNotNil(manager.dataChannelBus)
        XCTAssertTrue(manager.dataChannelBus?.localChannel === session.dataChannels.first)
    }

    func testRemoteDataChannelAdoptedIntoBus() async throws {
        let (manager, session, _) = makeManager()
        session.remoteChannelLabels = ["vidcall"]

        try await manager.receiveRemoteOffer(OfferPayload(sdp: "remote-offer-sdp"))

        let bus = try XCTUnwrap(manager.dataChannelBus)
        XCTAssertNotNil(bus.remoteChannel, "remote channel must be adopted into the bus")
        XCTAssertEqual(bus.remoteChannel?.label, "vidcall")
        XCTAssertTrue(bus.activeChannel === bus.remoteChannel, "remote channel wins over local")
    }

    func testBusSendAndReceiveRoundTrip() throws {
        let local = FakeDataChannel(label: "vidcall")
        let remote = FakeDataChannel(label: "vidcall")
        local.onSend = { data in remote.deliver(data) }
        remote.onSend = { data in local.deliver(data) }

        // Two buses over one pipe (as if each side owns one channel).
        let busA = DataChannelBus(channel: local)
        let busB = DataChannelBus(channel: remote)
        local.open()
        remote.open()

        let received = ValueBox<ChatPayload>()
        busB.onChat = { received.set($0) }
        try busA.sendChat("hello over SCTP")

        XCTAssertEqual(received.value?.text, "hello over SCTP")
    }

    // MARK: Bus raw sends + bufferedAmount

    func testBusRawStringAndBytesSends() throws {
        let channel = FakeDataChannel(label: "vidcall")
        let bus = DataChannelBus(channel: channel)
        channel.open()

        try bus.sendString("hello")
        try bus.sendBytes(Data([0x00, 0x01, 0xFF]))

        XCTAssertEqual(channel.sent.count, 2)
        XCTAssertEqual(channel.sent[0], Data("hello".utf8), "string send is UTF-8 text")
        XCTAssertEqual(channel.sentBinary, [false, true], "string=text frame, bytes=binary frame")
    }

    func testBusRawSendsRequireOpenChannel() throws {
        let channel = FakeDataChannel(label: "vidcall")
        let bus = DataChannelBus(channel: channel)

        XCTAssertThrowsError(try bus.sendString("nope")) { error in
            guard case DataChannelBusError.notOpen = error else {
                return XCTFail("expected notOpen, got \(error)")
            }
        }
        XCTAssertThrowsError(try bus.sendBytes(Data([0x01]))) { error in
            guard case DataChannelBusError.notOpen = error else {
                return XCTFail("expected notOpen, got \(error)")
            }
        }
    }

    func testBusExposesBufferedAmount() {
        let channel = FakeDataChannel(label: "vidcall")
        let bus = DataChannelBus(channel: channel)
        XCTAssertEqual(bus.bufferedAmount, 0)

        let changes = ValueBox<[UInt64]>()
        changes.set([])
        bus.onBufferedAmountChange = { amount in
            var current = changes.value ?? []
            current.append(amount)
            changes.set(current)
        }

        channel.simulateBufferedAmountChange(1024)
        XCTAssertEqual(bus.bufferedAmount, 1024)
        channel.simulateBufferedAmountChange(0)
        XCTAssertEqual(bus.bufferedAmount, 0)
        XCTAssertEqual(changes.value, [1024, 0])
    }

    // MARK: Sender filtering

    func testRemotePeerIdFiltersForeignSenders() async throws {
        let (manager, session, signaling) = makeManager(remotePeerId: "peer-b")

        // An offer from an unknown sender is ignored.
        let envelope = Envelope(
            type: .offer,
            roomId: "room",
            senderId: "attacker",
            sessionId: "s",
            ts: 1,
            seq: 1,
            payload: .offer(OfferPayload(sdp: "evil-sdp"))
        )
        manager.handleIncoming(event: .offer(envelope, OfferPayload(sdp: "evil-sdp")))
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(session.appliedRemote.count, 0)
        XCTAssertEqual(signaling.answers.count, 0)

        // An offer from the expected peer is processed.
        let good = Envelope(
            type: .offer,
            roomId: "room",
            senderId: "peer-b",
            sessionId: "s",
            ts: 2,
            seq: 1,
            payload: .offer(OfferPayload(sdp: "good-sdp"))
        )
        manager.handleIncoming(event: .offer(good, OfferPayload(sdp: "good-sdp")))
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(session.appliedRemote.count, 1)
        XCTAssertEqual(signaling.answers.count, 1)
    }

    // MARK: Helpers

    /// Polls until `session.addedCandidates` reaches `count` (async adds).
    private func waitForCandidates(_ session: FakePeerConnectionSession, count: Int) async {
        let deadline = Date().addingTimeInterval(2)
        while session.addedCandidates.count < count && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }
}
