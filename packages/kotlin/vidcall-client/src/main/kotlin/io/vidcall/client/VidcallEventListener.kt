package io.vidcall.client

import io.vidcall.protocol.AnswerPayload
import io.vidcall.protocol.ChatPayload
import io.vidcall.protocol.Envelope
import io.vidcall.protocol.ErrorPayload
import io.vidcall.protocol.IcePayload
import io.vidcall.protocol.JoinPayload
import io.vidcall.protocol.LeavePayload
import io.vidcall.protocol.OfferPayload
import io.vidcall.protocol.PresencePayload
import io.vidcall.protocol.QualityWarningPayload
import io.vidcall.protocol.ReactionPayload
import io.vidcall.protocol.ScreenSharePayload
import io.vidcall.protocol.SfuPayload

/**
 * Typed callbacks for incoming envelopes. Implement the subset you need —
 * every method has a no-op default.
 *
 * Callbacks are invoked on the transport's thread; hop to your UI/main
 * dispatcher inside the callbacks when needed.
 */
interface VidcallEventListener {

    /** Transport reached CONNECTED. */
    fun onConnected() {}

    /** Transport dropped (or closed). */
    fun onDisconnected() {}

    /** A participant sent a `join` envelope. */
    fun onJoin(senderId: String, payload: JoinPayload, envelope: Envelope) {}

    /** A participant sent a `leave` envelope. */
    fun onLeave(senderId: String, payload: LeavePayload, envelope: Envelope) {}

    /** WebRTC offer from a peer (mesh signaling). */
    fun onOffer(senderId: String, payload: OfferPayload, envelope: Envelope) {}

    /** WebRTC answer from a peer. */
    fun onAnswer(senderId: String, payload: AnswerPayload, envelope: Envelope) {}

    /** Trickled ICE candidate from a peer. */
    fun onIce(senderId: String, payload: IcePayload, envelope: Envelope) {}

    fun onPresence(senderId: String, payload: PresencePayload, envelope: Envelope) {}

    fun onReaction(senderId: String, payload: ReactionPayload, envelope: Envelope) {}

    fun onChat(senderId: String, payload: ChatPayload, envelope: Envelope) {}

    fun onScreenShare(senderId: String, payload: ScreenSharePayload, envelope: Envelope) {}

    fun onQualityWarning(payload: QualityWarningPayload, envelope: Envelope) {}

    fun onSfu(payload: SfuPayload, envelope: Envelope) {}

    /** Protocol/transport error. `envelope` is null for transport-level failures. */
    fun onError(payload: ErrorPayload, envelope: Envelope?) {}

    /** A peer pinged; the client answers automatically with a pong. */
    fun onPing(envelope: Envelope) {}

    fun onPong(envelope: Envelope) {}
}
