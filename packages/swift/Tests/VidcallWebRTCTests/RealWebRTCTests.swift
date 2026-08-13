//
//  RealWebRTCTests.swift
//  VidcallWebRTCTests
//
//  L2 loopback against real GoogleWebRTC (the pinned `WebRTC` 150.0.0 binary
//  target). Compiled and run only when the `WebRTC` module is linked; in
//  fully-offline builds (scripts/disable-webrtc.sh) this file compiles to
//  nothing and the same scenarios run against fakes in LoopbackTests.swift.
//

#if canImport(WebRTC)

import XCTest
import Vidcall
@testable import VidcallWebRTC
import WebRTC

final class RealWebRTCTests: XCTestCase {
    /// Two real peer connections on one machine, connected through the same
    /// in-process signaling bridge: full offer/answer/ICE + SCTP data
    /// roundtrip over GoogleWebRTC.
    func testTwoRealPeersConnectAndExchangeData() async throws {
        // Loopback on localhost: host candidates only (no STUN needed).
        let configuration = PeerConnectionConfiguration(iceServers: [], polite: true)
        guard
            let sessionA = RTCPeerConnectionSession.make(configuration: configuration),
            let sessionB = RTCPeerConnectionSession.make(configuration: configuration)
        else {
            throw XCTSkip("GoogleWebRTC session could not be created")
        }
        let bridge = SignalingBridge()

        let managerA = PeerConnectionManager(
            session: sessionA,
            configuration: configuration,
            signaling: bridge.endpoint(isA: true),
            remotePeerId: "peer-b"
        )
        let managerB = PeerConnectionManager(
            session: sessionB,
            configuration: PeerConnectionConfiguration(polite: false),
            signaling: bridge.endpoint(isA: false),
            remotePeerId: "peer-a"
        )
        bridge.managerA = managerA
        bridge.managerB = managerB

        let busA = try XCTUnwrap(managerA.dataChannelBus)
        let busB = try XCTUnwrap(managerB.dataChannelBus)

        // Negotiate. Real WebRTC fires `negotiationneeded` as soon as the
        // data channel is created, so both sides may auto-negotiate before or
        // after the explicit call; the first drain can therefore come up
        // empty. Drain the bridge until the glare resolves and both sides
        // hold `stable` with an empty queue for a quiescence streak, which
        // guarantees no offer is still in flight (bounded settle loop).
        try await managerA.negotiate()
        var quiescentSamples = 0
        var settled = false
        for _ in 0..<100 {
            try await bridge.processAll()
            if bridge.isEmpty,
                sessionA.signalingState == .stable,
                sessionB.signalingState == .stable
            {
                quiescentSamples += 1
                if quiescentSamples >= 5 {
                    settled = true
                    break
                }
            } else {
                quiescentSamples = 0
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(settled, "peers did not converge to stable: A=\(sessionA.signalingState) B=\(sessionB.signalingState)")

        // Wait for the data channels to open over real SCTP.
        try await busA.open(timeoutMs: 15_000)
        try await busB.open(timeoutMs: 15_000)
        XCTAssertTrue(busA.isOpen)
        XCTAssertTrue(busB.isOpen)

        // Data roundtrip.
        let received = ValueBox<ChatPayload>()
        busB.onChat = { received.set($0) }
        try busA.sendChat("hello over real SCTP")
        try await waitUntil(timeout: 10) { received.value != nil }
        XCTAssertEqual(received.value?.text, "hello over real SCTP")

        // Cleanup.
        managerA.leave()
        managerB.leave()
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(condition(), "condition not met within \(timeout)s")
    }
}

#endif // canImport(WebRTC)
