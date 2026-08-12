//
//  VidcallClientTests.swift
//  VidcallTests
//
//  Offline unit tests for VidcallClient envelope building (seq monotonicity,
//  configuration wiring, session id override) and error paths. Transport-level
//  behavior (connect/send over a real WebSocket) is covered by L2 integration
//  tests against a signaling backend — see README "Testing".
//

import XCTest
@testable import Vidcall

final class VidcallClientTests: XCTestCase {
    private func makeClient(sessionId: String? = nil) -> VidcallClient {
        VidcallClient(configuration: VidcallClient.Configuration(
            url: URL(string: "wss://relay.example.com/signal")!,
            roomId: "room-abc",
            senderId: "user-42",
            sessionId: sessionId
        ))
    }

    func testEnvelopeUsesConfigurationAndGeneratedSessionId() {
        let client = makeClient()
        let envelope = client.makeEnvelope(type: .ping)

        XCTAssertEqual(envelope.v, 1)
        XCTAssertEqual(envelope.type, .ping)
        XCTAssertEqual(envelope.roomId, "room-abc")
        XCTAssertEqual(envelope.senderId, "user-42")
        XCTAssertEqual(envelope.sessionId, client.currentSessionId)
        XCTAssertFalse(envelope.sessionId.isEmpty)
        XCTAssertEqual(envelope.seq, 1)
        XCTAssertEqual(envelope.payload, .none)
        XCTAssertEqual(client.state, .idle)
    }

    func testSeqIsMonotonicPerSender() {
        let client = makeClient()
        let seqs = (0..<5).map { _ in client.makeEnvelope(type: .ping).seq }
        XCTAssertEqual(seqs, [1, 2, 3, 4, 5])
    }

    func testUpdateSessionIdOverrides() {
        let client = makeClient()
        client.updateSessionId("sess-999")
        let envelope = client.makeEnvelope(type: .ping)
        XCTAssertEqual(envelope.sessionId, "sess-999")
        XCTAssertEqual(client.currentSessionId, "sess-999")
    }

    func testTypedSenderPayloadsMatchSchema() throws {
        let client = makeClient(sessionId: "sess-001")

        let join = client.makeEnvelope(type: .join, payload: .join(JoinPayload(
            displayName: "Alice",
            deviceProfile: DeviceProfile(hardwareConcurrency: 8, mobile: true, platform: .swift),
            capabilities: Capabilities(simulcast: true, codecs: ["H264"])
        )))
        guard case .join(let joinPayload) = join.payload else {
            return XCTFail("expected join payload")
        }
        XCTAssertEqual(joinPayload.displayName, "Alice")
        XCTAssertEqual(joinPayload.deviceProfile?.platform, .swift)

        let chat = client.makeEnvelope(type: .chat, payload: .chat(ChatPayload(text: "hi")))
        guard case .chat(let chatPayload) = chat.payload else {
            return XCTFail("expected chat payload")
        }
        XCTAssertEqual(chatPayload.text, "hi")

        let reaction = client.makeEnvelope(type: .reaction, payload: .reaction(ReactionPayload(emoji: "👍", targetSenderId: "user-7")))
        guard case .reaction(let reactionPayload) = reaction.payload else {
            return XCTFail("expected reaction payload")
        }
        XCTAssertEqual(reactionPayload.emoji, "👍")
        XCTAssertEqual(reactionPayload.targetSenderId, "user-7")

        // Wire keys stay snake_case per schema.
        let data = try JSONEncoder().encode(reaction)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "reaction")
        let payload = object?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["targetSenderId"] as? String, "user-7")
        XCTAssertEqual(payload?["emoji"] as? String, "👍")
    }

    func testSendWithoutConnectionThrows() {
        let client = makeClient()
        XCTAssertThrowsError(try client.chat(text: "hi")) { error in
            XCTAssertEqual(error as? VidcallError, .notConnected)
        }
        XCTAssertThrowsError(try client.send(Envelope(
            type: .ping, roomId: "r", senderId: "s", sessionId: "x", ts: 1, seq: 1
        ))) { error in
            XCTAssertEqual(error as? VidcallError, .notConnected)
        }
    }

    func testDisconnectWithoutConnectIsSafe() {
        let client = makeClient()
        client.disconnect()
        XCTAssertEqual(client.state, .disconnected)
    }
}
