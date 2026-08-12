package io.vidcall.android

import android.content.Context
import io.vidcall.client.SignalingTransport
import io.vidcall.client.VidcallClient
import io.vidcall.client.VidcallConfig
import io.vidcall.client.VidcallEventListener
import io.vidcall.protocol.ChatPayload
import io.vidcall.protocol.ChatReplyTo
import io.vidcall.protocol.Envelope
import io.vidcall.protocol.ErrorPayload
import io.vidcall.protocol.PresencePayload
import io.vidcall.protocol.QualityWarningPayload
import io.vidcall.protocol.ReactionPayload
import io.vidcall.protocol.ScreenSharePayload
import io.vidcall.protocol.SfuPayload
import kotlinx.serialization.json.JsonObject
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection

/** Default no-op RTC listener. */
private val NOOP_RTC_LISTENER = object : VidcallRtcListener {}

/** High-level RTC events; every method is an optional no-op. */
interface VidcallRtcListener {
    fun onConnected() {}
    fun onDisconnected() {}
    fun onPeerJoined(peerId: String) {}
    fun onPeerLeft(peerId: String) {}
    fun onRemoteTrack(peerId: String, track: MediaStreamTrack) {}
    fun onRemoteAudioTrack(peerId: String, track: org.webrtc.AudioTrack) {}
    fun onRemoteVideoTrack(peerId: String, track: org.webrtc.VideoTrack) {}
    fun onIceConnectionState(peerId: String, state: PeerConnection.IceConnectionState) {}
    fun onChat(peerId: String, payload: ChatPayload) {}
    fun onReaction(peerId: String, payload: ReactionPayload) {}
    fun onPresence(peerId: String, payload: PresencePayload) {}
    fun onScreenShare(peerId: String, payload: ScreenSharePayload) {}
    fun onQualityWarning(payload: QualityWarningPayload) {}
    fun onError(payload: ErrorPayload) {}
}

/**
 * Full mesh client: [VidcallClient] signaling + org.webrtc peer connections.
 *
 * Wiring:
 * - the client joins the room and broadcasts `join`;
 * - every incoming `join` adds that peer to the mesh (one PeerConnection per
 *   remote client), with a deterministic initiator (smaller `senderId` offers,
 *   see [shouldInitiate]) so exactly one side creates the initial offer;
 * - offer/answer/ICE envelopes are exchanged through the signaling transport
 *   and applied to the peer connections ([PeerConnectionManager]).
 *
 * Attach local media before [join] via [setLocalMedia]. Screen capture
 * (MediaProjection) requires app-side permission handling; once you have a
 * [org.webrtc.VideoCapturer], attach it via [WebRtcFactory.attachCapturer]
 * and call [startScreenShare] to announce + renegotiate.
 */
class VidcallRtcClient(
    context: Context,
    roomId: String,
    clientId: String,
    sessionId: String,
    private val transport: SignalingTransport,
    private val rtcConfig: RtcConfig = RtcConfig(),
    private val listener: VidcallRtcListener = NOOP_RTC_LISTENER,
) {

    private val appContext = context.applicationContext

    private val factory = WebRtcFactory.createFactory(appContext)

    // Listener/adapters are declared before the client and manager they wire
    // into; their methods only touch `signaling`/`manager` at callback time
    // (after construction), so forward references are safe inside method bodies.
    private val signalingListener = object : VidcallEventListener {

        override fun onConnected() = listener.onConnected()
        override fun onDisconnected() = listener.onDisconnected()

        override fun onJoin(senderId: String, payload: io.vidcall.protocol.JoinPayload, envelope: Envelope) {
            if (senderId == signaling.config.clientId) return // own join echo
            listener.onPeerJoined(senderId)
            ensurePeer(senderId)
        }

        override fun onLeave(senderId: String, payload: io.vidcall.protocol.LeavePayload, envelope: Envelope) {
            if (senderId == signaling.config.clientId) return
            manager.removePeer(senderId)
            listener.onPeerLeft(senderId)
        }

        override fun onOffer(senderId: String, payload: io.vidcall.protocol.OfferPayload, envelope: Envelope) {
            ensurePeer(senderId)
            manager.onRemoteOffer(senderId, payload.sdp)
        }

        override fun onAnswer(senderId: String, payload: io.vidcall.protocol.AnswerPayload, envelope: Envelope) {
            manager.onRemoteAnswer(senderId, payload.sdp)
        }

        override fun onIce(senderId: String, payload: io.vidcall.protocol.IcePayload, envelope: Envelope) {
            manager.onRemoteIce(senderId, payload.candidate, payload.sdpMid, payload.sdpMLineIndex)
        }

        override fun onChat(senderId: String, payload: ChatPayload, envelope: Envelope) = listener.onChat(senderId, payload)
        override fun onReaction(senderId: String, payload: ReactionPayload, envelope: Envelope) =
            listener.onReaction(senderId, payload)
        override fun onPresence(senderId: String, payload: PresencePayload, envelope: Envelope) =
            listener.onPresence(senderId, payload)
        override fun onScreenShare(senderId: String, payload: ScreenSharePayload, envelope: Envelope) =
            listener.onScreenShare(senderId, payload)
        override fun onQualityWarning(payload: QualityWarningPayload, envelope: Envelope) =
            listener.onQualityWarning(payload)
        override fun onSfu(payload: SfuPayload, envelope: Envelope) = Unit
        override fun onError(payload: ErrorPayload, envelope: Envelope?) = listener.onError(payload)
        override fun onPing(envelope: Envelope) = Unit
        override fun onPong(envelope: Envelope) = Unit
    }

    private val signalingAdapter = object : PeerSignaling {
        // Unicast per-peer signaling carries the schema `targetSenderId` envelope
        // field (absent = room broadcast, sender-excluded relay).
        override fun sendOffer(peerId: String, payload: io.vidcall.protocol.OfferPayload) =
            signaling.sendOffer(payload.sdp, payload.label, targetSenderId = peerId)

        override fun sendAnswer(peerId: String, payload: io.vidcall.protocol.AnswerPayload) =
            signaling.sendAnswer(payload.sdp, payload.label, targetSenderId = peerId)

        override fun sendIce(peerId: String, payload: io.vidcall.protocol.IcePayload) =
            signaling.sendIce(payload.candidate, payload.sdpMid, payload.sdpMLineIndex, targetSenderId = peerId)
    }

    private val peerEvents = object : PeerEvents {
        override fun onRemoteTrack(peerId: String, track: MediaStreamTrack) = listener.onRemoteTrack(peerId, track)
        override fun onRemoteAudioTrack(peerId: String, track: org.webrtc.AudioTrack) =
            listener.onRemoteAudioTrack(peerId, track)
        override fun onRemoteVideoTrack(peerId: String, track: org.webrtc.VideoTrack) =
            listener.onRemoteVideoTrack(peerId, track)
        override fun onIceConnectionState(peerId: String, state: PeerConnection.IceConnectionState) =
            listener.onIceConnectionState(peerId, state)
        override fun onPeerClosed(peerId: String) = Unit
    }

    private val signaling: VidcallClient = VidcallClient(
        config = VidcallConfig(roomId = roomId, clientId = clientId, sessionId = sessionId),
        transport = transport,
        listener = signalingListener,
    )

    private val manager = PeerConnectionManager(
        factory = factory,
        config = rtcConfig,
        signaling = signalingAdapter,
        events = peerEvents,
    )

    @Volatile
    private var localMedia: PeerConnectionManager.LocalMedia? = null

    /** Low-level signaling client (chat/reactions/presence go through it too). */
    val signalingClient: VidcallClient get() = signaling

    /** The internal WebRTC factory (use it to build screen-share sources/tracks). */
    val peerConnectionFactory: org.webrtc.PeerConnectionFactory get() = factory

    /** Convenience: build local mic+camera media with this client's factory. */
    fun createLocalMedia(
        audioEnabled: Boolean = true,
        videoEnabled: Boolean = true,
        videoWidth: Int = 1280,
        videoHeight: Int = 720,
        videoFps: Int = 30,
    ): PeerConnectionManager.LocalMedia = WebRtcFactory.createLocalMedia(
        context = appContext,
        factory = factory,
        audioEnabled = audioEnabled,
        videoEnabled = videoEnabled,
        videoWidth = videoWidth,
        videoHeight = videoHeight,
        videoFps = videoFps,
    )

    /** Configure the tracks attached to every peer connection (call before [join]). */
    fun setLocalMedia(media: PeerConnectionManager.LocalMedia) {
        localMedia = media
    }

    fun connect(
        displayName: String? = null,
        metadata: JsonObject = JsonObject(emptyMap()),
        deviceProfile: io.vidcall.protocol.DeviceProfile? = null,
        capabilities: io.vidcall.protocol.Capabilities? = null,
    ) {
        signaling.connect()
        signaling.join(displayName, metadata, deviceProfile, capabilities)
    }

    /** Leave the room and tear down all peer connections + transport. */
    fun leave(reason: String? = null) {
        signaling.leave(reason)
        manager.closeAll()
        signaling.disconnect()
    }

    fun sendChat(text: String, replyTo: ChatReplyTo? = null) = signaling.sendChat(text, replyTo)

    fun sendReaction(emoji: String, targetSenderId: String? = null) = signaling.sendReaction(emoji, targetSenderId)

    fun sendPresence(state: io.vidcall.protocol.PresenceState, metadata: JsonObject = JsonObject(emptyMap())) =
        signaling.sendPresence(state, metadata)

    /**
     * Announce screen sharing and attach the given track to all peers.
     * The track/capturer are app-owned (MediaProjection capture) — see
     * [WebRtcFactory.createScreenVideoSource] / [createScreenTrack].
     */
    fun startScreenShare(track: org.webrtc.VideoTrack, label: String? = null) {
        for (peerId in manager.peerIds) manager.addLocalTrack(peerId, track)
        signaling.screenShare(start = true, label = label)
    }

    fun stopScreenShare(label: String? = null) {
        signaling.screenShare(start = false, label = label)
    }

    /**
     * Add the peer to the mesh with the deterministic polarity, then have the
     * designated initiator create the first offer.
     */
    private fun ensurePeer(peerId: String) {
        if (manager.hasPeer(peerId)) return
        val media = localMedia ?: return
        val polite = !shouldInitiate(signaling.config.clientId, peerId)
        if (manager.addPeer(peerId, media, polite)) {
            if (!polite) manager.negotiate(peerId)
        }
    }
}
