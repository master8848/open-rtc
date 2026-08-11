package io.vidcall.client

import io.vidcall.protocol.AnswerPayload
import io.vidcall.protocol.Capabilities
import io.vidcall.protocol.ChatPayload
import io.vidcall.protocol.ChatReplyTo
import io.vidcall.protocol.DeviceProfile
import io.vidcall.protocol.Envelope
import io.vidcall.protocol.ErrorPayload
import io.vidcall.protocol.IcePayload
import io.vidcall.protocol.JoinPayload
import io.vidcall.protocol.LeavePayload
import io.vidcall.protocol.MessageType
import io.vidcall.protocol.OfferPayload
import io.vidcall.protocol.PresencePayload
import io.vidcall.protocol.PresenceState
import io.vidcall.protocol.Protocol
import io.vidcall.protocol.QualityWarningPayload
import io.vidcall.protocol.ReactionPayload
import io.vidcall.protocol.ScreenShareAction
import io.vidcall.protocol.ScreenSharePayload
import io.vidcall.protocol.SfuPayload
import io.vidcall.protocol.decodeAsPayload
import io.vidcall.protocol.encodeAsPayload
import java.util.LinkedHashSet
import kotlinx.serialization.json.JsonObject

/**
 * vidcall signaling client (backend-agnostic).
 *
 * Speaks the schema.json envelope contract over any [SignalingTransport]
 * ([WebSocketTransport] or [RestTransport] ship with the library; custom
 * transports may wrap Supabase/Convex/Firebase/... pub/sub). Sending methods
 * emit typed payloads; incoming envelopes are dispatched to [VidcallEventListener]
 * callbacks. The client owns per-sender sequencing, idempotent delivery
 * (dedupe by `senderId`+`seq`), and automatic pong replies, per the schema's
 * "engine owns ordering/idempotency" note.
 *
 * Threading: callbacks arrive on the transport thread; sending is thread-safe.
 * Envelope `targetSessionId` parameters are transport-level routing hints for
 * unicast offer/answer/ice (see [SignalingTransport]).
 */
class VidcallClient(
    val config: VidcallConfig,
    private val transport: SignalingTransport,
    private val listener: VidcallEventListener = NoopListener,
    private val now: () -> Long = System::currentTimeMillis,
) {

    private var seq = 0L
    private val seen = LinkedHashSet<Pair<String, Long>>()

    @Volatile
    var isConnected: Boolean = false
        private set

    /** Connect the transport and start receiving envelopes. */
    fun connect() {
        transport.connect(object : TransportListener {
            override fun onMessage(envelope: Envelope) = dispatch(envelope)
            override fun onState(state: TransportState) {
                isConnected = state == TransportState.CONNECTED
                when (state) {
                    TransportState.CONNECTED -> listener.onConnected()
                    TransportState.DISCONNECTED -> listener.onDisconnected()
                    else -> Unit
                }
            }
            override fun onFailure(error: Throwable) {
                listener.onError(ErrorPayload("transport", error.message ?: "transport failure"), null)
            }
        })
    }

    /** Close the transport. The client can be reconnected with a new [connect]. */
    fun disconnect() {
        transport.close()
        isConnected = false
    }

    // ------------------------------------------------------------------
    // Sending (all payloads mirror protocol/schema.json)
    // ------------------------------------------------------------------

    fun join(
        displayName: String? = null,
        metadata: JsonObject = JsonObject(emptyMap()),
        deviceProfile: DeviceProfile? = null,
        capabilities: Capabilities? = null,
    ) {
        send(MessageType.JOIN, JoinPayload(displayName, metadata, deviceProfile, capabilities).encodeAsPayload())
    }

    fun leave(reason: String? = null) {
        send(MessageType.LEAVE, LeavePayload(reason).encodeAsPayload())
    }

    fun sendPresence(state: PresenceState, metadata: JsonObject = JsonObject(emptyMap())) {
        send(MessageType.PRESENCE, PresencePayload(state, metadata).encodeAsPayload())
    }

    fun sendReaction(emoji: String, targetSenderId: String? = null, timestamp: Long? = now()) {
        require(emoji.isNotBlank()) { "emoji must not be blank" }
        send(MessageType.REACTION, ReactionPayload(emoji, targetSenderId, timestamp).encodeAsPayload())
    }

    fun sendChat(text: String, replyTo: ChatReplyTo? = null) {
        require(text.isNotBlank()) { "chat text must not be blank" }
        require(text.length <= Protocol.MAX_CHAT_TEXT_LENGTH) {
            "chat text exceeds schema maxLength ${Protocol.MAX_CHAT_TEXT_LENGTH}"
        }
        send(MessageType.CHAT, ChatPayload(text, replyTo).encodeAsPayload())
    }

    /** Start/stop screen sharing. The screen capturer itself is app-owned. */
    fun screenShare(start: Boolean, label: String? = null) {
        val action = if (start) ScreenShareAction.START else ScreenShareAction.STOP
        send(MessageType.SCREEN_SHARE, ScreenSharePayload(action, label).encodeAsPayload())
    }

    fun sendQualityWarning(payload: QualityWarningPayload) {
        send(MessageType.QUALITY_WARNING, payload.encodeAsPayload())
    }

    fun sendSfu(payload: SfuPayload) {
        send(MessageType.SFU, payload.encodeAsPayload())
    }

    fun sendError(code: String, message: String) {
        send(MessageType.ERROR, ErrorPayload(code, message).encodeAsPayload())
    }

    /** Outbound WebRTC offer (unicast to [targetSessionId] when set). */
    fun sendOffer(sdp: String, label: String? = null, targetSessionId: String? = null) {
        send(MessageType.OFFER, OfferPayload(sdp, label).encodeAsPayload(), targetSessionId)
    }

    /** Outbound WebRTC answer (unicast to [targetSessionId] when set). */
    fun sendAnswer(sdp: String, label: String? = null, targetSessionId: String? = null) {
        send(MessageType.ANSWER, AnswerPayload(sdp, label).encodeAsPayload(), targetSessionId)
    }

    /** Outbound trickled ICE candidate (unicast to [targetSessionId] when set). */
    fun sendIce(candidate: String, sdpMid: String? = null, sdpMLineIndex: Int? = null, targetSessionId: String? = null) {
        send(MessageType.ICE, IcePayload(candidate, sdpMid, sdpMLineIndex).encodeAsPayload(), targetSessionId)
    }

    /** Low-level escape hatch: send any envelope (broadcast unless [targetSessionId] set). */
    fun sendRaw(envelope: Envelope, targetSessionId: String? = null) {
        transport.send(envelope, targetSessionId)
    }

    fun ping() {
        send(MessageType.PING, JsonObject(emptyMap()))
    }

    // ------------------------------------------------------------------
    // Incoming dispatch
    // ------------------------------------------------------------------

    private fun dispatch(envelope: Envelope) {
        if (envelope.v != Protocol.VERSION) {
            listener.onError(
                ErrorPayload("protocol-version", "unsupported protocol version ${envelope.v}"),
                envelope,
            )
            return
        }
        if (!seen.add(envelope.senderId to envelope.seq)) {
            return // duplicate (senderId, seq): idempotent delivery
        }
        trimSeen()
        when (envelope.type) {
            MessageType.JOIN -> typed(envelope) { p: JoinPayload -> listener.onJoin(envelope.senderId, p, envelope) }
            MessageType.LEAVE -> typed(envelope) { p: LeavePayload -> listener.onLeave(envelope.senderId, p, envelope) }
            MessageType.OFFER -> typed(envelope) { p: OfferPayload -> listener.onOffer(envelope.senderId, p, envelope) }
            MessageType.ANSWER -> typed(envelope) { p: AnswerPayload -> listener.onAnswer(envelope.senderId, p, envelope) }
            MessageType.ICE -> typed(envelope) { p: IcePayload -> listener.onIce(envelope.senderId, p, envelope) }
            MessageType.PRESENCE -> typed(envelope) { p: PresencePayload -> listener.onPresence(envelope.senderId, p, envelope) }
            MessageType.REACTION -> typed(envelope) { p: ReactionPayload -> listener.onReaction(envelope.senderId, p, envelope) }
            MessageType.CHAT -> typed(envelope) { p: ChatPayload -> listener.onChat(envelope.senderId, p, envelope) }
            MessageType.SCREEN_SHARE -> typed(envelope) { p: ScreenSharePayload -> listener.onScreenShare(envelope.senderId, p, envelope) }
            MessageType.QUALITY_WARNING -> typed(envelope) { p: QualityWarningPayload -> listener.onQualityWarning(p, envelope) }
            MessageType.SFU -> typed(envelope) { p: SfuPayload -> listener.onSfu(p, envelope) }
            MessageType.ERROR -> typed(envelope) { p: ErrorPayload -> listener.onError(p, envelope) }
            MessageType.PING -> {
                listener.onPing(envelope)
                // engine-level keepalive: answer pings with a pong
                send(MessageType.PONG, JsonObject(emptyMap()))
            }
            MessageType.PONG -> listener.onPong(envelope)
        }
    }

    private inline fun <reified T> typed(envelope: Envelope, block: (T) -> Unit) {
        try {
            block(envelope.payload.decodeAsPayload())
        } catch (e: Exception) {
            listener.onError(
                ErrorPayload("bad-payload", "cannot decode ${envelope.type} payload: ${e.message}"),
                envelope,
            )
        }
    }

    private fun send(type: MessageType, payload: JsonObject, targetSessionId: String? = null) {
        transport.send(buildEnvelope(type, payload), targetSessionId)
    }

    private fun buildEnvelope(type: MessageType, payload: JsonObject): Envelope =
        Envelope(
            type = type,
            roomId = config.roomId,
            senderId = config.clientId,
            sessionId = config.sessionId,
            ts = now(),
            seq = ++seq,
            payload = payload,
        )

    /** Bound the dedupe cache so long sessions don't grow without limit. */
    private fun trimSeen() {
        if (seen.size > MAX_SEEN) {
            val iterator = seen.iterator()
            var removed = 0
            while (iterator.hasNext() && removed < MAX_SEEN / 4) {
                iterator.next()
                iterator.remove()
                removed++
            }
        }
    }

    companion object {
        private const val MAX_SEEN = 4096

        /** Default no-op listener so callers only implement what they need. */
        private val NoopListener = object : VidcallEventListener {}
    }
}
