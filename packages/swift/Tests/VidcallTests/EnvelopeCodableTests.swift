//
//  EnvelopeCodableTests.swift
//  VidcallTests
//
//  Codable round-trip tests against three sample envelopes taken from
//  protocol/schema.json (join / offer / ice). All tests run offline — they
//  exercise the wire format only (L0 protocol conformance; see
//  docs/research/mobile-bindings.md §4).
//

import XCTest
@testable import Vidcall

final class EnvelopeCodableTests: XCTestCase {
    // MARK: Fixture helpers

    private func loadFixture(_ name: String) throws -> Data {
        // `.copy("Fixtures")` places files under a `Fixtures/` folder reference.
        let candidates = [
            Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"),
            Bundle.module.url(forResource: name, withExtension: "json"),
        ]
        guard let url = candidates.compactMap({ $0 }).first else {
            throw XCTSkip("Fixture \(name).json not found")
        }
        return try Data(contentsOf: url)
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: data)
        guard let dict = object as? [String: Any] else {
            throw XCTSkip("Expected JSON object")
        }
        return dict
    }

    private func assertJSONEqual(_ lhs: Data, _ rhs: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let l = try jsonObject(lhs) as NSDictionary
        let r = try jsonObject(rhs) as NSDictionary
        XCTAssertEqual(l, r, file: file, line: line)
    }

    // MARK: Sample envelope 1 — join (schema.json JoinPayload)

    func testDecodeJoinEnvelope() throws {
        let envelope = try JSONDecoder().decode(Envelope.self, from: loadFixture("envelope-join"))

        XCTAssertEqual(envelope.v, 1)
        XCTAssertEqual(envelope.type, .join)
        XCTAssertEqual(envelope.roomId, "room-abc")
        XCTAssertEqual(envelope.senderId, "user-42")
        XCTAssertEqual(envelope.sessionId, "sess-001")
        XCTAssertEqual(envelope.ts, 1_780_000_000_000)
        XCTAssertEqual(envelope.seq, 1)

        guard case .join(let join) = envelope.payload else {
            return XCTFail("Expected .join payload, got \(envelope.payload)")
        }
        XCTAssertEqual(join.displayName, "Alice")
        XCTAssertEqual(join.metadata?["muted"], .bool(false))
        XCTAssertEqual(join.metadata?["joinedFrom"], .string("swift"))
        XCTAssertEqual(join.deviceProfile?.hardwareConcurrency, 8)
        XCTAssertEqual(join.deviceProfile?.deviceMemory, 8.0)
        XCTAssertEqual(join.deviceProfile?.mobile, true)
        XCTAssertEqual(join.deviceProfile?.screenWidth, 1170)
        XCTAssertEqual(join.deviceProfile?.platform, .swift)
        XCTAssertEqual(join.capabilities?.simulcast, true)
        XCTAssertEqual(join.capabilities?.svc, false)
        XCTAssertEqual(join.capabilities?.codecs, ["H264", "VP8", "VP9"])
    }

    func testJoinEnvelopeRoundTrip() throws {
        let original = try loadFixture("envelope-join")
        let envelope = try JSONDecoder().decode(Envelope.self, from: original)

        let encoded = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(Envelope.self, from: encoded)

        XCTAssertEqual(decoded, envelope)
        try assertJSONEqual(encoded, original)
    }

    // MARK: Sample envelope 2 — offer (schema.json OfferPayload)

    func testDecodeOfferEnvelope() throws {
        let envelope = try JSONDecoder().decode(Envelope.self, from: loadFixture("envelope-offer"))

        XCTAssertEqual(envelope.type, .offer)
        XCTAssertEqual(envelope.senderId, "user-7")
        XCTAssertEqual(envelope.seq, 7)

        guard case .offer(let offer) = envelope.payload else {
            return XCTFail("Expected .offer payload, got \(envelope.payload)")
        }
        XCTAssertTrue(offer.sdp.contains("m=audio"))
        XCTAssertTrue(offer.sdp.contains("a=fingerprint:sha-256"))
        XCTAssertEqual(offer.label, "main")
    }

    func testOfferEnvelopeRoundTrip() throws {
        let original = try loadFixture("envelope-offer")
        let envelope = try JSONDecoder().decode(Envelope.self, from: original)

        let encoded = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(Envelope.self, from: encoded)

        XCTAssertEqual(decoded, envelope)
        try assertJSONEqual(encoded, original)
    }

    // MARK: Sample envelope 3 — ice (schema.json IcePayload)

    func testDecodeIceEnvelope() throws {
        let envelope = try JSONDecoder().decode(Envelope.self, from: loadFixture("envelope-ice"))

        XCTAssertEqual(envelope.type, .ice)
        XCTAssertEqual(envelope.seq, 8)

        guard case .ice(let ice) = envelope.payload else {
            return XCTFail("Expected .ice payload, got \(envelope.payload)")
        }
        XCTAssertEqual(ice.candidate, "candidate:842163049 1 udp 1677729535 192.0.2.1 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag 7Qyq network-cost 999")
        XCTAssertEqual(ice.sdpMid, "0")
        XCTAssertEqual(ice.sdpMLineIndex, 0)
    }

    func testIceEnvelopeRoundTrip() throws {
        let original = try loadFixture("envelope-ice")
        let envelope = try JSONDecoder().decode(Envelope.self, from: original)

        let encoded = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(Envelope.self, from: encoded)

        XCTAssertEqual(decoded, envelope)
        try assertJSONEqual(encoded, original)
    }

    // MARK: Nullable ICE fields (schema.json: sdpMid/sdpMLineIndex are nullable)

    func testIceNullableFieldsRoundTrip() throws {
        let payload = IcePayload(candidate: "candidate:1 1 udp 1 192.0.2.2 50000 typ host", sdpMid: nil, sdpMLineIndex: nil)
        let envelope = Envelope(
            type: .ice, roomId: "r", senderId: "s", sessionId: "x",
            ts: 1, seq: 1, payload: .ice(payload)
        )
        let encoded = try JSONEncoder().encode(envelope)
        let object = try jsonObject(encoded)
        // Optional nils are omitted on encode; decode must yield nil again.
        XCTAssertNil(object["sdpMid"])
        XCTAssertNil(object["sdpMLineIndex"])

        let decoded = try JSONDecoder().decode(Envelope.self, from: encoded)
        guard case .ice(let ice) = decoded.payload else {
            return XCTFail("Expected .ice payload")
        }
        XCTAssertNil(ice.sdpMid)
        XCTAssertNil(ice.sdpMLineIndex)
    }

    // MARK: Forward compatibility (schema.json: tolerate unknown types/values)

    func testUnknownMessageTypeIsTolerated() throws {
        let json = """
        {"v":1,"type":"warp-drive","roomId":"r","senderId":"s","sessionId":"x",
         "ts":1,"seq":1,"payload":{"flux":42}}
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(Envelope.self, from: json)
        XCTAssertEqual(envelope.type, .unknown("warp-drive"))
        guard case .unknown(let raw) = envelope.payload else {
            return XCTFail("Expected .unknown payload, got \(envelope.payload)")
        }
        XCTAssertEqual(raw, .object(["flux": .number(42)]))

        // Round trip preserves the raw payload.
        let decoded = try JSONDecoder().decode(Envelope.self, from: JSONEncoder().encode(envelope))
        XCTAssertEqual(decoded, envelope)
    }

    func testUnknownPresenceStateIsTolerated() throws {
        let json = """
        {"v":1,"type":"presence","roomId":"r","senderId":"s","sessionId":"x",
         "ts":1,"seq":1,"payload":{"state":"interstellar"}}
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(Envelope.self, from: json)
        guard case .presence(let presence) = envelope.payload else {
            return XCTFail("Expected .presence payload")
        }
        XCTAssertEqual(presence.state, .unknown("interstellar"))
    }

    // MARK: ping/pong carry no payload

    func testPingEnvelopeOmitsPayload() throws {
        let json = """
        {"v":1,"type":"ping","roomId":"r","senderId":"s","sessionId":"x","ts":1,"seq":9}
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(Envelope.self, from: json)
        XCTAssertEqual(envelope.type, .ping)
        XCTAssertEqual(envelope.payload, .none)

        let encoded = try JSONEncoder().encode(envelope)
        let object = try jsonObject(encoded)
        XCTAssertNil(object["payload"], "ping must not carry a payload key")
    }

    // MARK: Required fields

    func testMissingRequiredFieldThrows() throws {
        let json = """
        {"v":1,"type":"chat","roomId":"r","senderId":"s","sessionId":"x","ts":1}
        """.data(using: .utf8)! // missing seq

        XCTAssertThrowsError(try JSONDecoder().decode(Envelope.self, from: json))
    }

    func testChatAndReactionRoundTrip() throws {
        let chat = Envelope(
            type: .chat, roomId: "r", senderId: "s", sessionId: "x", ts: 2, seq: 2,
            payload: .chat(ChatPayload(text: "hey 👋", replyTo: ChatReplyTo(senderId: "user-7", seq: 7)))
        )
        let reaction = Envelope(
            type: .reaction, roomId: "r", senderId: "s", sessionId: "x", ts: 3, seq: 3,
            payload: .reaction(ReactionPayload(emoji: "🎉", targetSenderId: "user-7", ts: 3))
        )

        for envelope in [chat, reaction] {
            let decoded = try JSONDecoder().decode(Envelope.self, from: JSONEncoder().encode(envelope))
            XCTAssertEqual(decoded, envelope)
        }

        let chatObject = try jsonObject(JSONEncoder().encode(chat))
        XCTAssertEqual(chatObject["type"] as? String, "chat")
        guard let chatPayload = chatObject["payload"] as? [String: Any] else {
            return XCTFail("expected chat payload object")
        }
        XCTAssertEqual(chatPayload["text"] as? String, "hey 👋")
        let replyTo = chatPayload["replyTo"] as? [String: Any]
        XCTAssertEqual(replyTo?["senderId"] as? String, "user-7")
    }

    // MARK: JSONValue

    func testJSONValueRoundTrip() throws {
        let value = JSONValue.object([
            "null": .null,
            "bool": .bool(true),
            "number": .number(3.5),
            "string": .string("s"),
            "array": .array([.number(1), .number(2), .number(3)]),
            "nested": .object(["a": .string("b")]),
        ])
        let decoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(decoded, value)
        XCTAssertEqual(decoded.objectValue?["array"]?.arrayValue?.count, 3)
    }
}
