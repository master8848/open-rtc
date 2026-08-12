package io.vidcall.protocol

import kotlinx.serialization.EncodeDefault
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
 * `payload` is a JSON object (schema `type: object`); when absent (e.g. `ping` /
 * `pong`) the `payload` key is omitted on the wire (see [Protocol.json]).
 * `targetSenderId` (optional) addresses one peer; absent = room broadcast with a
 * sender-excluded relay, present = relayed only to that participant (receivers
 * MUST filter on it). Glare polarity: `polite = selfId < remoteId` (lexicographic).
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
    /** Monotonic per sender per session, starting at 0 (schema: >= 0). */
    val seq: Long,
    /**
     * Schema `targetSenderId`: optional unicast target (a peer `senderId`) for
     * signal payloads. Absent = room broadcast (sender-excluded relay); present =
     * relayed only to the addressed participant. Receivers MUST filter on it.
     */
    val targetSenderId: String? = null,
    /** Type-specific payload as a JSON object; omitted when empty (ping/pong). */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val payload: JsonObject = JsonObject(emptyMap()),
)
