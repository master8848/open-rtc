package io.vidcall.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

/**
 * vidcall protocol constants and shared JSON codec.
 *
 * All bindings must serialize envelopes exactly per `protocol/schema.json`; this
 * codec is what the Kotlin binding uses everywhere (client, transports, tests).
 */
object Protocol {

    /** Schema `v` const. */
    const val VERSION: Int = 1

    /** Schema `ChatPayload.text` maxLength. */
    const val MAX_CHAT_TEXT_LENGTH: Int = 4000

    /**
     * Shared JSON codec:
     * - [Json.encodeDefaults] = true  — always write defaulted fields (stable wire form);
     * - [Json.explicitNulls] = false  — omit nullable fields when null (schema optionality);
     * - [Json.ignoreUnknownKeys] = true — tolerate additive schema evolution.
     */
    val json: Json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }
}

/** Decode this payload object into a typed payload (e.g. `JoinPayload`). */
inline fun <reified T> JsonObject.decodeAsPayload(): T =
    Protocol.json.decodeFromJsonElement(this)

/** Encode a typed payload (e.g. [JoinPayload]) into a [JsonObject] for the envelope. */
inline fun <reified T> T.encodeAsPayload(): JsonObject =
    Protocol.json.encodeToJsonElement(this) as JsonObject
