package io.vidcall.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Envelope types, mirrors the `type` enum of `protocol/schema.json`.
 *
 * Wire names are the schema enum values (`screen-share`, `quality-warning`, ...);
 * the Kotlin names are idiomatic upper-camel identifiers.
 */
@Serializable
enum class MessageType {
    @SerialName("join") JOIN,
    @SerialName("leave") LEAVE,
    @SerialName("offer") OFFER,
    @SerialName("answer") ANSWER,
    @SerialName("ice") ICE,
    @SerialName("presence") PRESENCE,
    @SerialName("reaction") REACTION,
    @SerialName("chat") CHAT,
    @SerialName("screen-share") SCREEN_SHARE,
    @SerialName("quality-warning") QUALITY_WARNING,
    @SerialName("sfu") SFU,
    @SerialName("error") ERROR,
    @SerialName("ping") PING,
    @SerialName("pong") PONG,
}
