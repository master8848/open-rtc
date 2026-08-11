package io.vidcall.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The vidcall wire envelope, mirrors the root object of `protocol/schema.json`.
 *
 * The envelope is the single wire contract shared by the JS / Kotlin / Swift / Dart
 * bindings. It is carried as-is over any pluggable backend transport (WebSocket,
 * REST relay, Supabase/Convex/Firebase pub/sub, ...); backends stay dumb and the
 * engine owns ordering / idempotency / glare handling.
 *
 * Required wire fields: `v`, `type`, `roomId`, `senderId`, `sessionId`, `ts`, `seq`.
 * `payload` is a JSON object (schema `type: object`); absent payloads are encoded
 * as `{}` (see [Protocol.json]).
 */
@Serializable
data class Envelope(
    /** Protocol version. The schema pins this to `1` ([Protocol.VERSION]). */
    val v: Int = Protocol.VERSION,
    val type: MessageType,
    /** Room the message is broadcast to (one channel per room). */
    val roomId: String,
    /** Stable identity of the sending client. */
    val senderId: String,
    /** Identity of the sending *session*: a new value per join, so reconnects are distinct. */
    val sessionId: String,
    /** Epoch milliseconds (schema: integer). */
    val ts: Long,
    /** Monotonic per sender; the engine dedupes/reorders by it (schema: >= 0). */
    val seq: Long,
    /** Type-specific payload as a JSON object. */
    val payload: JsonObject = JsonObject(emptyMap()),
)
