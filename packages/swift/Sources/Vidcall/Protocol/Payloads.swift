//
//  Payloads.swift
//  Vidcall
//
//  Codable payload structs mirroring every payload definition in
//  protocol/schema.json. Field names and types follow the schema exactly;
//  optional schema fields map to optionals here. Unknown values of closed
//  enums are preserved via `LenientStringEnum` (forward compatibility).
//

import Foundation

// MARK: - Join

/// Device profile sent at join (schema.json `DeviceProfile`).
public struct DeviceProfile: Codable, Equatable, Sendable {
    public var hardwareConcurrency: Int
    /// GB; Chrome-only.
    public var deviceMemory: Double?
    public var mobile: Bool
    public var screenWidth: Int?
    public var screenHeight: Int?
    public var platform: Platform?

    public init(
        hardwareConcurrency: Int,
        deviceMemory: Double? = nil,
        mobile: Bool,
        screenWidth: Int? = nil,
        screenHeight: Int? = nil,
        platform: Platform? = nil
    ) {
        self.hardwareConcurrency = hardwareConcurrency
        self.deviceMemory = deviceMemory
        self.mobile = mobile
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.platform = platform
    }
}

/// Client platform (schema.json `DeviceProfile.platform`).
public enum Platform: LenientStringEnum {
    case browser
    case node
    case kotlin
    case swift
    case dart
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> Platform {
        switch rawValue {
        case "browser": return .browser
        case "node": return .node
        case "kotlin": return .kotlin
        case "swift": return .swift
        case "dart": return .dart
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .browser: return "browser"
        case .node: return "node"
        case .kotlin: return "kotlin"
        case .swift: return "swift"
        case .dart: return "dart"
        case .unknown(let raw): return raw
        }
    }
}

/// Join capabilities (schema.json `JoinPayload.capabilities`).
public struct Capabilities: Codable, Equatable, Sendable {
    public var simulcast: Bool?
    public var svc: Bool?
    public var codecs: [String]?

    public init(simulcast: Bool? = nil, svc: Bool? = nil, codecs: [String]? = nil) {
        self.simulcast = simulcast
        self.svc = svc
        self.codecs = codecs
    }
}

/// Payload for `type: "join"` (schema.json `JoinPayload`).
public struct JoinPayload: Codable, Equatable, Sendable {
    public var displayName: String?
    public var metadata: [String: JSONValue]?
    public var deviceProfile: DeviceProfile?
    public var capabilities: Capabilities?

    public init(
        displayName: String? = nil,
        metadata: [String: JSONValue]? = nil,
        deviceProfile: DeviceProfile? = nil,
        capabilities: Capabilities? = nil
    ) {
        self.displayName = displayName
        self.metadata = metadata
        self.deviceProfile = deviceProfile
        self.capabilities = capabilities
    }
}

// MARK: - Leave

/// Payload for `type: "leave"` (schema.json `LeavePayload`).
public struct LeavePayload: Codable, Equatable, Sendable {
    public var reason: String?

    public init(reason: String? = nil) {
        self.reason = reason
    }
}

// MARK: - Offer / Answer (SDP)

/// Payload for `type: "offer"` and `type: "answer"` (schema.json `OfferPayload`).
/// SDP is relayed verbatim — never parsed or transformed by the signaling layer.
public struct OfferPayload: Codable, Equatable, Sendable {
    public var sdp: String
    public var label: String?

    public init(sdp: String, label: String? = nil) {
        self.sdp = sdp
        self.label = label
    }
}

// MARK: - ICE

/// Payload for `type: "ice"` (schema.json `IcePayload`). Trickle ICE:
/// candidates are relayed verbatim.
public struct IcePayload: Codable, Equatable, Sendable {
    public var candidate: String
    public var sdpMid: String?
    public var sdpMLineIndex: Int?

    public init(candidate: String, sdpMid: String? = nil, sdpMLineIndex: Int? = nil) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
    }
}

// MARK: - Presence

/// Presence state (schema.json `PresencePayload.state`).
public enum PresenceState: LenientStringEnum {
    case online
    case away
    case busy
    case offline
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> PresenceState {
        switch rawValue {
        case "online": return .online
        case "away": return .away
        case "busy": return .busy
        case "offline": return .offline
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .online: return "online"
        case .away: return "away"
        case .busy: return "busy"
        case .offline: return "offline"
        case .unknown(let raw): return raw
        }
    }
}

/// Payload for `type: "presence"` (schema.json `PresencePayload`).
public struct PresencePayload: Codable, Equatable, Sendable {
    public var state: PresenceState
    public var metadata: [String: JSONValue]?

    public init(state: PresenceState, metadata: [String: JSONValue]? = nil) {
        self.state = state
        self.metadata = metadata
    }
}

// MARK: - Reaction

/// Payload for `type: "reaction"` (schema.json `ReactionPayload`).
public struct ReactionPayload: Codable, Equatable, Sendable {
    public var emoji: String
    public var targetSenderId: String?
    public var ts: Int64?

    public init(emoji: String, targetSenderId: String? = nil, ts: Int64? = nil) {
        self.emoji = emoji
        self.targetSenderId = targetSenderId
        self.ts = ts
    }
}

// MARK: - Chat

/// Reply reference (schema.json `ChatPayload.replyTo`).
public struct ChatReplyTo: Codable, Equatable, Sendable {
    public var senderId: String?
    public var seq: Int64?

    public init(senderId: String? = nil, seq: Int64? = nil) {
        self.senderId = senderId
        self.seq = seq
    }
}

/// Payload for `type: "chat"` (schema.json `ChatPayload`; `text` maxLength 4000).
public struct ChatPayload: Codable, Equatable, Sendable {
    public var text: String
    public var replyTo: ChatReplyTo?

    public init(text: String, replyTo: ChatReplyTo? = nil) {
        self.text = text
        self.replyTo = replyTo
    }
}

// MARK: - Screen share

/// Screen-share action (schema.json `ScreenSharePayload.action`).
public enum ScreenShareAction: LenientStringEnum {
    case start
    case stop
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> ScreenShareAction {
        switch rawValue {
        case "start": return .start
        case "stop": return .stop
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .start: return "start"
        case .stop: return "stop"
        case .unknown(let raw): return raw
        }
    }
}

/// Payload for `type: "screen-share"` (schema.json `ScreenSharePayload`).
public struct ScreenSharePayload: Codable, Equatable, Sendable {
    public var action: ScreenShareAction
    public var label: String?

    public init(action: ScreenShareAction, label: String? = nil) {
        self.action = action
        self.label = label
    }
}

// MARK: - Quality warning

/// Quality-warning reason (schema.json `QualityWarningPayload.reason`).
public enum QualityReason: LenientStringEnum {
    case network
    case cpu
    case device
    case manual
    case recovery
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> QualityReason {
        switch rawValue {
        case "network": return .network
        case "cpu": return .cpu
        case "device": return .device
        case "manual": return .manual
        case "recovery": return .recovery
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .network: return "network"
        case .cpu: return "cpu"
        case .device: return "device"
        case .manual: return "manual"
        case .recovery: return "recovery"
        case .unknown(let raw): return raw
        }
    }
}

/// Quality-warning direction (schema.json `QualityWarningPayload.direction`).
public enum QualityDirection: LenientStringEnum {
    case send
    case receive
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> QualityDirection {
        switch rawValue {
        case "send": return .send
        case "receive": return .receive
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .send: return "send"
        case .receive: return "receive"
        case .unknown(let raw): return raw
        }
    }
}

/// Payload for `type: "quality-warning"` (schema.json `QualityWarningPayload`).
public struct QualityWarningPayload: Codable, Equatable, Sendable {
    /// Quality tier, e.g. "720p@30".
    public var from: String
    public var to: String
    public var reason: QualityReason
    public var direction: QualityDirection

    public init(from: String, to: String, reason: QualityReason, direction: QualityDirection) {
        self.from = from
        self.to = to
        self.reason = reason
        self.direction = direction
    }
}

// MARK: - SFU

/// SFU action (schema.json `SfuPayload.action`).
public enum SfuAction: LenientStringEnum {
    case publish
    case subscribe
    case layerChange
    case keyframeRequest
    case leave
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> SfuAction {
        switch rawValue {
        case "publish": return .publish
        case "subscribe": return .subscribe
        case "layer-change": return .layerChange
        case "keyframe-request": return .keyframeRequest
        case "leave": return .leave
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .publish: return "publish"
        case .subscribe: return "subscribe"
        case .layerChange: return "layer-change"
        case .keyframeRequest: return "keyframe-request"
        case .leave: return "leave"
        case .unknown(let raw): return raw
        }
    }
}

/// SFU track kind (schema.json `SfuPayload.kind`).
public enum SfuTrackKind: LenientStringEnum {
    case audio
    case video
    case screen
    case unknown(String)

    public static func fromWire(_ rawValue: String) -> SfuTrackKind {
        switch rawValue {
        case "audio": return .audio
        case "video": return .video
        case "screen": return .screen
        default: return .unknown(rawValue)
        }
    }

    public var wireValue: String {
        switch self {
        case .audio: return "audio"
        case .video: return "video"
        case .screen: return "screen"
        case .unknown(let raw): return raw
        }
    }
}

/// Payload for `type: "sfu"` (schema.json `SfuPayload`).
public struct SfuPayload: Codable, Equatable, Sendable {
    public var action: SfuAction
    public var trackId: String?
    public var kind: SfuTrackKind?
    public var senderId: String?
    public var layer: String?

    public init(
        action: SfuAction,
        trackId: String? = nil,
        kind: SfuTrackKind? = nil,
        senderId: String? = nil,
        layer: String? = nil
    ) {
        self.action = action
        self.trackId = trackId
        self.kind = kind
        self.senderId = senderId
        self.layer = layer
    }
}

// MARK: - Error

/// Payload for `type: "error"` (schema.json `ErrorPayload`).
public struct ErrorPayload: Codable, Equatable, Sendable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}
