package io.vidcall.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// ---------------------------------------------------------------------------
// Payloads, mirroring `protocol/schema.json` `definitions.*`.
// Nullable fields correspond to schema-optional properties; with
// `explicitNulls = false` they are omitted from the wire when null.
// ---------------------------------------------------------------------------

@Serializable
enum class DevicePlatform {
    @SerialName("browser") BROWSER,
    @SerialName("node") NODE,
    @SerialName("kotlin") KOTLIN,
    @SerialName("swift") SWIFT,
    @SerialName("dart") DART,
}

/** `DeviceProfile` — sent at join time so peers/engine can pick initial quality. */
@Serializable
data class DeviceProfile(
    /** Schema-required; >= 1. */
    val hardwareConcurrency: Int,
    /** Schema-required. */
    val mobile: Boolean,
    /** GB; Chrome-only in JS, optional here. */
    val deviceMemory: Double? = null,
    val screenWidth: Int? = null,
    val screenHeight: Int? = null,
    val platform: DevicePlatform? = null,
)

/** `capabilities` object inside [JoinPayload]. */
@Serializable
data class Capabilities(
    val simulcast: Boolean? = null,
    val svc: Boolean? = null,
    val codecs: List<String>? = null,
)

/** `JoinPayload`. */
@Serializable
data class JoinPayload(
    val displayName: String? = null,
    val metadata: JsonObject = JsonObject(emptyMap()),
    val deviceProfile: DeviceProfile? = null,
    val capabilities: Capabilities? = null,
)

/** `LeavePayload`. */
@Serializable
data class LeavePayload(
    val reason: String? = null,
)

/** `OfferPayload` (schema reuses this shape for `answer`). */
@Serializable
data class OfferPayload(
    /** Schema-required: the SDP body (RFC 3264). */
    val sdp: String,
    /** Optional label identifying the media/track, e.g. "main" or "screen". */
    val label: String? = null,
)

/**
 * `answer` payload. The schema points `answer` at `OfferPayload`; this type is
 * kept distinct so callbacks read naturally, and serializes to the same shape.
 */
@Serializable
data class AnswerPayload(
    val sdp: String,
    val label: String? = null,
)

/** `IcePayload` — one trickled ICE candidate (RFC 8445). */
@Serializable
data class IcePayload(
    /** Schema-required: the candidate SDP fragment, e.g. `candidate:...`. */
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
)

@Serializable
enum class PresenceState {
    @SerialName("online") ONLINE,
    @SerialName("away") AWAY,
    @SerialName("busy") BUSY,
    @SerialName("offline") OFFLINE,
}

/** `PresencePayload`. */
@Serializable
data class PresencePayload(
    /** Schema-required. */
    val state: PresenceState,
    val metadata: JsonObject = JsonObject(emptyMap()),
)

/** `ReactionPayload`. */
@Serializable
data class ReactionPayload(
    /** Schema-required. */
    val emoji: String,
    val targetSenderId: String? = null,
    /** Reaction timestamp (epoch ms); defaults to now when sending. */
    val ts: Long? = null,
)

/** `replyTo` inside [ChatPayload]. */
@Serializable
data class ChatReplyTo(
    val senderId: String,
    val seq: Long,
)

/** `ChatPayload` — schema caps `text` at 4000 chars ([Protocol.MAX_CHAT_TEXT_LENGTH]). */
@Serializable
data class ChatPayload(
    val text: String,
    val replyTo: ChatReplyTo? = null,
)

@Serializable
enum class ScreenShareAction {
    @SerialName("start") START,
    @SerialName("stop") STOP,
}

/** `ScreenSharePayload`. */
@Serializable
data class ScreenSharePayload(
    /** Schema-required. */
    val action: ScreenShareAction,
    val label: String? = null,
)

@Serializable
enum class QualityWarningReason {
    @SerialName("network") NETWORK,
    @SerialName("cpu") CPU,
    @SerialName("device") DEVICE,
    @SerialName("manual") MANUAL,
    @SerialName("recovery") RECOVERY,
}

@Serializable
enum class QualityWarningDirection {
    @SerialName("send") SEND,
    @SerialName("receive") RECEIVE,
}

/** `QualityWarningPayload`. */
@Serializable
data class QualityWarningPayload(
    val from: String,
    val to: String,
    val reason: QualityWarningReason,
    val direction: QualityWarningDirection,
)

@Serializable
enum class SfuAction {
    @SerialName("publish") PUBLISH,
    @SerialName("subscribe") SUBSCRIBE,
    @SerialName("layer-change") LAYER_CHANGE,
    @SerialName("keyframe-request") KEYFRAME_REQUEST,
    @SerialName("leave") LEAVE,
}

@Serializable
enum class SfuKind {
    @SerialName("audio") AUDIO,
    @SerialName("video") VIDEO,
    @SerialName("screen") SCREEN,
}

/** `SfuPayload` — optional SFU gateway control (not required for mesh). */
@Serializable
data class SfuPayload(
    /** Schema-required. */
    val action: SfuAction,
    val trackId: String? = null,
    val kind: SfuKind? = null,
    val senderId: String? = null,
    val layer: String? = null,
)

/** `ErrorPayload`. */
@Serializable
data class ErrorPayload(
    /** Schema-required: machine-readable code, e.g. "protocol-version". */
    val code: String,
    /** Schema-required: human-readable message. */
    val message: String,
)
