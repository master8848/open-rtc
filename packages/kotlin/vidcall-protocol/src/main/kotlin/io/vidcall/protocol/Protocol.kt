package io.vidcall.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import java.util.logging.Logger

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

    /**
     * Wire `type` names of every known [MessageType] (the schema `type` enum),
     * derived from the serializer descriptor so it cannot drift from the
     * `@SerialName` values.
     */
    private val knownWireTypes: Set<String> = run {
        val descriptor = MessageType.serializer().descriptor
        (0 until descriptor.elementsCount).mapTo(mutableSetOf()) { descriptor.getElementName(it) }
    }

    private val logger: Logger = Logger.getLogger("io.vidcall.protocol")

    /**
     * Tolerant envelope decode per `protocol/schema.json` wire rules: "unknown
     * `type` values are ignored + logged (clients MUST NOT fail decode)".
     *
     * Returns the decoded [Envelope], or `null` when the envelope's `type` is
     * not a known schema value — the envelope is logged and skipped, so an
     * additive protocol evolution cannot wedge a client. Malformed JSON and
     * missing required fields still throw [kotlinx.serialization.SerializationException]:
     * those are local bugs, not forward compatibility.
     */
    fun decodeEnvelopeOrNull(text: String): Envelope? {
        val element = json.parseToJsonElement(text)
        val typeName = (element as? JsonObject)?.get("type")?.let { (it as? JsonPrimitive)?.content }
        if (typeName != null && typeName !in knownWireTypes) {
            logger.warning(
                "ignoring envelope with unknown type '$typeName' " +
                    "(schema rule: unknown types are ignored + logged; clients must not fail decode)",
            )
            return null
        }
        return json.decodeFromString(Envelope.serializer(), text)
    }
}

/** Decode this payload object into a typed payload (e.g. `JoinPayload`). */
inline fun <reified T> JsonObject.decodeAsPayload(): T =
    Protocol.json.decodeFromJsonElement(this)

/** Encode a typed payload (e.g. [JoinPayload]) into a [JsonObject] for the envelope. */
inline fun <reified T> T.encodeAsPayload(): JsonObject =
    Protocol.json.encodeToJsonElement(this) as JsonObject
