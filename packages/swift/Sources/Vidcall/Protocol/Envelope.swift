//
//  Envelope.swift
//  Vidcall
//
//  The wire envelope defined by protocol/schema.json:
//    { "v", "type", "roomId", "senderId", "sessionId", "ts", "seq", "payload" }
//  Required fields: v, type, roomId, senderId, sessionId, ts, seq.
//  Unknown `type` values are preserved (MessageType.unknown) instead of
//  failing decode — schema.json requires clients to "tolerate unknown type
//  values (ignore + log)".
//

import Foundation

/// A string enum whose unknown wire values are preserved rather than throwing.
/// Used for all closed enums in schema.json so forward-compatible additions
/// never break decoding of an envelope.
public protocol LenientStringEnum: Codable, Hashable, Sendable {
    /// Maps a wire string to a known case, or `.unknown(wireString)`.
    static func fromWire(_ rawValue: String) -> Self
    /// The wire representation of this value.
    var wireValue: String { get }
}

extension LenientStringEnum {
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self.fromWire(value)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wireValue)
    }
}

/// Message types defined by protocol/schema.json.
public enum MessageType: LenientStringEnum {
    case join
    case leave
    case offer
    case answer
    case ice
    case presence
    case reaction
    case chat
    case screenShare
    case qualityWarning
    case sfu
    case error
    case ping
    case pong
    /// Unknown / forward-compatible type; the raw wire string is preserved.
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> MessageType {
        switch rawValue {
        case "join": return .join
        case "leave": return .leave
        case "offer": return .offer
        case "answer": return .answer
        case "ice": return .ice
        case "presence": return .presence
        case "reaction": return .reaction
        case "chat": return .chat
        case "screen-share": return .screenShare
        case "quality-warning": return .qualityWarning
        case "sfu": return .sfu
        case "error": return .error
        case "ping": return .ping
        case "pong": return .pong
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .join: return "join"
        case .leave: return "leave"
        case .offer: return "offer"
        case .answer: return "answer"
        case .ice: return "ice"
        case .presence: return "presence"
        case .reaction: return "reaction"
        case .chat: return "chat"
        case .screenShare: return "screen-share"
        case .qualityWarning: return "quality-warning"
        case .sfu: return "sfu"
        case .error: return "error"
        case .ping: return "ping"
        case .pong: return "pong"
        case .unknown(let raw): return raw
        }
    }
}

/// Typed payload carried by an `Envelope`. The associated value mirrors the
/// payload definition for the envelope's `type` in protocol/schema.json.
public enum Payload: Equatable, Sendable {
    case join(JoinPayload)
    case leave(LeavePayload)
    case offer(OfferPayload)
    case answer(OfferPayload)
    case ice(IcePayload)
    case presence(PresencePayload)
    case reaction(ReactionPayload)
    case chat(ChatPayload)
    case screenShare(ScreenSharePayload)
    case qualityWarning(QualityWarningPayload)
    case sfu(SfuPayload)
    case error(ErrorPayload)
    /// No payload — ping/pong, or a `payload` key that is absent/null.
    case none
    /// Unknown `type` — the raw payload JSON is preserved unmodified.
    case unknown(JSONValue?)

    /// Decodes a payload for the given envelope type. Unknown types keep the
    /// raw JSON; ping/pong carry no payload.
    public static func decode(type: MessageType, raw: JSONValue?) throws -> Payload {
        switch type {
        case .join: return .join(try Self._decode(raw))
        case .leave: return .leave(try Self._decode(raw))
        case .offer: return .offer(try Self._decode(raw))
        case .answer: return .answer(try Self._decode(raw))
        case .ice: return .ice(try Self._decode(raw))
        case .presence: return .presence(try Self._decode(raw))
        case .reaction: return .reaction(try Self._decode(raw))
        case .chat: return .chat(try Self._decode(raw))
        case .screenShare: return .screenShare(try Self._decode(raw))
        case .qualityWarning: return .qualityWarning(try Self._decode(raw))
        case .sfu: return .sfu(try Self._decode(raw))
        case .error: return .error(try Self._decode(raw))
        case .ping, .pong: return .none
        case .unknown: return .unknown(raw)
        }
    }

    private static func _decode<T: Decodable>(_ raw: JSONValue?) throws -> T {
        guard let raw else {
            throw DecodingError.valueNotFound(
                T.self,
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "Envelope of this type requires a payload"
                )
            )
        }
        let data = try JSONEncoder().encode(raw)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

extension Payload: Codable {
    public init(from decoder: Decoder) throws {
        // Payloads are decoded by `Envelope` (which knows `type`). This init
        // exists so `Payload` is Codable; standalone decoding preserves the raw
        // JSON as `.unknown`.
        let raw = try JSONValue(from: decoder)
        self = .unknown(raw)
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .join(let payload): try payload.encode(to: encoder)
        case .leave(let payload): try payload.encode(to: encoder)
        case .offer(let payload): try payload.encode(to: encoder)
        case .answer(let payload): try payload.encode(to: encoder)
        case .ice(let payload): try payload.encode(to: encoder)
        case .presence(let payload): try payload.encode(to: encoder)
        case .reaction(let payload): try payload.encode(to: encoder)
        case .chat(let payload): try payload.encode(to: encoder)
        case .screenShare(let payload): try payload.encode(to: encoder)
        case .qualityWarning(let payload): try payload.encode(to: encoder)
        case .sfu(let payload): try payload.encode(to: encoder)
        case .error(let payload): try payload.encode(to: encoder)
        case .none:
            break
        case .unknown(let raw):
            if let raw {
                try raw.encode(to: encoder)
            } else {
                var container = encoder.singleValueContainer()
                try container.encodeNil()
            }
        }
    }
}

/// The signaling envelope. Mirrors the top-level object in protocol/schema.json.
public struct Envelope: Equatable, Sendable {
    /// Protocol version (schema.json `v`, const 1).
    public var v: Int
    public var type: MessageType
    public var roomId: String
    public var senderId: String
    public var sessionId: String
    /// Epoch milliseconds.
    public var ts: Int64
    /// Monotonic per sender; the engine dedupes/reorders.
    public var seq: UInt64
    public var payload: Payload

    public init(
        v: Int = 1,
        type: MessageType,
        roomId: String,
        senderId: String,
        sessionId: String,
        ts: Int64,
        seq: UInt64,
        payload: Payload = .none
    ) {
        self.v = v
        self.type = type
        self.roomId = roomId
        self.senderId = senderId
        self.sessionId = sessionId
        self.ts = ts
        self.seq = seq
        self.payload = payload
    }
}

extension Envelope: Codable {
    private enum CodingKeys: String, CodingKey {
        case v, type, roomId, senderId, sessionId, ts, seq, payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.v = try container.decode(Int.self, forKey: .v)
        self.type = try container.decode(MessageType.self, forKey: .type)
        self.roomId = try container.decode(String.self, forKey: .roomId)
        self.senderId = try container.decode(String.self, forKey: .senderId)
        self.sessionId = try container.decode(String.self, forKey: .sessionId)
        self.ts = try container.decode(Int64.self, forKey: .ts)
        self.seq = try container.decode(UInt64.self, forKey: .seq)

        if container.contains(.payload) {
            let raw = try container.decodeIfPresent(JSONValue.self, forKey: .payload)
            self.payload = try Payload.decode(type: type, raw: raw)
        } else {
            self.payload = .none
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(type, forKey: .type)
        try container.encode(roomId, forKey: .roomId)
        try container.encode(senderId, forKey: .senderId)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(ts, forKey: .ts)
        try container.encode(seq, forKey: .seq)
        switch payload {
        case .none:
            break // ping/pong carry no `payload` key on the wire
        default:
            try container.encode(payload, forKey: .payload)
        }
    }
}
