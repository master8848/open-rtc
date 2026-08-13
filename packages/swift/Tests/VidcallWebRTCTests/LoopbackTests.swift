//
//  LoopbackTests.swift
//  VidcallWebRTCTests
//
//  L2 loopback: two full peers (manager + fake peer connection session +
//  data-channel bus) connected through an in-process signaling bridge. The
//  bridge routes offer/answer/ICE payloads between the peers exactly like a
//  signaling backend, so the whole perfect-negotiation + trickle-ICE + data
//  channel stack is exercised end to end without a network:
//
//    1. A negotiates → offer crosses the bridge → B answers → answer returns
//    2. trickle ICE candidates from A are queued at B until the offer lands
//    3. A's data channel opens on both sides → chat roundtrip over the bus
//    4. renegotiation + ICE restart still produce consistent state
//
//  A real-WebRTC variant (same bridge, real GoogleWebRTC sessions) runs when
//  the `WebRTC` binary target is enabled — see RealWebRTCTests.swift.
//

import XCTest
import Vidcall
@testable import VidcallWebRTC

final class LoopbackTests: XCTestCase {
    private struct Peers {
        let managerA: PeerConnectionManager
        let managerB: PeerConnectionManager
        let pair: LoopbackPair
        let bridge: SignalingBridge
    }

    private func makePeers(
        politeA: Bool = true,
        politeB: Bool = false,
        gatherIce: Bool = true
    ) -> Peers {
        let pair = LoopbackPair()
        pair.wireDataChannels()
        let bridge = SignalingBridge()

        let managerA = PeerConnectionManager(
            session: pair.sessionA,
            configuration: PeerConnectionConfiguration(polite: politeA),
            signaling: bridge.endpoint(isA: true),
            remotePeerId: "peer-b"
        )
        let managerB = PeerConnectionManager(
            session: pair.sessionB,
            configuration: PeerConnectionConfiguration(polite: politeB),
            signaling: bridge.endpoint(isA: false),
            remotePeerId: "peer-a"
        )
        pair.sessionA.shouldGatherCandidates = gatherIce
        pair.sessionB.shouldGatherCandidates = gatherIce
        bridge.managerA = managerA
        bridge.managerB = managerB
        return Peers(managerA: managerA, managerB: managerB, pair: pair, bridge: bridge)
    }

    /// Full loopback: A offers, B answers, ICE crosses, data channel carries
    /// a chat message back and forth.
    func testTwoPeersConnectAndExchangeData() async throws {
        let peers = makePeers()
        let busA = try XCTUnwrap(peers.managerA.dataChannelBus)
        let busB = try XCTUnwrap(peers.managerB.dataChannelBus)

        // A initiates; the bridge carries offer → B, answer → A.
        try await peers.managerA.negotiate()
        try await peers.bridge.processAll()

        XCTAssertEqual(peers.pair.sessionA.signalingState, .stable)
        XCTAssertEqual(peers.pair.sessionB.signalingState, .stable)
        XCTAssertEqual(peers.pair.sessionB.createdAnswers.count, 1)
        XCTAssertEqual(peers.pair.sessionA.appliedRemote.map(\.type), [.answer])

        // Trickle ICE crossed the bridge and was applied (queued until the
        // remote description landed on the receiving side).
        XCTAssertEqual(peers.pair.sessionB.addedCandidates.count, 1)
        XCTAssertEqual(peers.pair.sessionA.addedCandidates.count, 1)

        // Data roundtrip: open the SCTP channels, then chat A → B and B → A.
        peers.pair.openChannels()
        XCTAssertTrue(busA.isOpen)
        XCTAssertTrue(busB.isOpen)

        let bReceived = ValueBox<ChatPayload>()
        let aReceived = ValueBox<ChatPayload>()
        busB.onChat = { bReceived.set($0) }
        busA.onChat = { aReceived.set($0) }

        try busA.sendChat("hello from A")
        XCTAssertEqual(bReceived.value?.text, "hello from A")

        try busB.sendChat("hello from B")
        XCTAssertEqual(aReceived.value?.text, "hello from B")

        // Reactions + control flow over the same pipe.
        let bReaction = ValueBox<ReactionPayload>()
        busB.onReaction = { bReaction.set($0) }
        try busA.sendReaction("\u{1F44D}", targetSenderId: "peer-b")
        XCTAssertEqual(bReaction.value?.emoji, "\u{1F44D}")
        XCTAssertEqual(bReaction.value?.targetSenderId, "peer-b")

        let bControl = ValueBox<ControlMessage>()
        busB.onControl = { bControl.set($0) }
        try busA.sendControl(ControlMessage(action: "keyframe-request", extra: ["layer": .string("fps-30")]))
        XCTAssertEqual(bControl.value?.action, "keyframe-request")
        XCTAssertEqual(bControl.value?.extra["layer"], .string("fps-30"))

        XCTAssertTrue(peers.bridge.failures.isEmpty, "bridge failures: \(peers.bridge.failures)")
    }

    /// Glare over the bridge: both sides negotiate simultaneously; the polite
    /// side (A) rolls back its local offer and answers B's.
    func testSimultaneousOffersResolveByPolarity() async throws {
        let peers = makePeers(politeA: true, politeB: false)
        let sessionA = peers.pair.sessionA
        let sessionB = peers.pair.sessionB

        // Both sides negotiate at the same time.
        try await peers.managerA.negotiate()
        try await peers.managerB.negotiate()
        try await peers.bridge.processAll()

        // A (polite) rolled back its own local offer and answered B's offer.
        XCTAssertEqual(sessionA.appliedLocal.map(\.type), [.offer, .rollback, .answer])
        XCTAssertEqual(sessionA.createdAnswers.count, 1)
        // B (impolite) ignored A's colliding offer and kept its own, but it
        // still applies A's ANSWER (which completes B's own offer).
        XCTAssertEqual(sessionB.appliedRemote.map(\.type), [.answer])
        XCTAssertEqual(sessionB.createdAnswers.count, 0)

        XCTAssertEqual(sessionA.signalingState, .stable)
        XCTAssertEqual(sessionB.signalingState, .stable)
        XCTAssertTrue(peers.bridge.failures.isEmpty)
    }

    /// ICE restart over the bridge: after a restart both sides converge on a
    /// fresh offer/answer exchange.
    func testIceRestartOverTheBridge() async throws {
        let peers = makePeers()
        try await peers.managerA.negotiate()
        try await peers.bridge.processAll()
        XCTAssertEqual(peers.pair.sessionA.signalingState, .stable)

        try await peers.managerA.restartIce()
        try await peers.bridge.processAll()

        XCTAssertTrue(peers.pair.sessionA.iceRestartRequested)
        XCTAssertEqual(peers.pair.sessionA.signalingState, .stable)
        XCTAssertEqual(peers.pair.sessionB.signalingState, .stable)
        XCTAssertEqual(peers.pair.sessionB.createdAnswers.count, 2)
        XCTAssertTrue(peers.bridge.failures.isEmpty)
    }

    /// Data channel survives renegotiation (track added → new offer).
    func testRenegotiationKeepsDataChannel() async throws {
        let peers = makePeers()
        try await peers.managerA.negotiate()
        try await peers.bridge.processAll()

        peers.pair.openChannels()
        try await peers.managerA.negotiate()
        try await peers.bridge.processAll()

        XCTAssertEqual(peers.pair.sessionA.signalingState, .stable)
        XCTAssertEqual(peers.pair.sessionB.signalingState, .stable)
        // The local channel still exists and the bus is still wired.
        XCTAssertEqual(peers.pair.sessionA.dataChannels.count, 1)
        XCTAssertNotNil(peers.managerA.dataChannelBus)
        XCTAssertTrue(peers.bridge.failures.isEmpty)
    }
}
