package io.vidcall.android

import io.vidcall.protocol.AnswerPayload
import io.vidcall.protocol.IcePayload
import io.vidcall.protocol.OfferPayload
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import org.webrtc.AudioTrack
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack

/** Outbound signaling hook: the manager emits offer/answer/ice wire payloads. */
interface PeerSignaling {
    fun sendOffer(peerId: String, payload: OfferPayload)
    fun sendAnswer(peerId: String, payload: AnswerPayload)
    fun sendIce(peerId: String, payload: IcePayload)
}

/** Events surfaced to the app; every method is an optional no-op. */
interface PeerEvents {
    fun onRemoteTrack(peerId: String, track: MediaStreamTrack) {}
    fun onRemoteAudioTrack(peerId: String, track: AudioTrack) {}
    fun onRemoteVideoTrack(peerId: String, track: VideoTrack) {}
    fun onIceConnectionState(peerId: String, state: PeerConnection.IceConnectionState) {}
    fun onPeerClosed(peerId: String) {}
}

/**
 * One [PeerConnection] per remote peer (mesh), wired to the vidcall signaling
 * protocol: offers/answers/ICE candidates are exchanged as wire payloads via
 * [PeerSignaling]; remote offers/answers/candidates arrive via the `onRemote*`
 * methods. Implements the canonical perfect-negotiation pattern:
 *
 * - the designated initiator (see [shouldInitiate]) creates the first offer;
 * - on glare (both sides offered), the polite side rolls back its local offer
 *   and accepts the remote one; the impolite side ignores the remote offer;
 * - ICE candidates received before the remote description are queued and
 *   drained once the description lands (trickle ICE).
 *
 * All org.webrtc callbacks run on WebRTC's internal threads; the manager is
 * thread-safe and only enqueues outbound signaling, so no locking is needed
 * beyond the concurrent collections.
 */
class PeerConnectionManager(
    private val factory: PeerConnectionFactory,
    private val config: RtcConfig,
    private val signaling: PeerSignaling,
    private val events: PeerEvents = object : PeerEvents {},
) {

    /** Local media bundle attached to every peer connection. */
    class LocalMedia(
        val audioTrack: AudioTrack? = null,
        val videoTrack: VideoTrack? = null,
    ) {
        val tracks: List<MediaStreamTrack> get() = listOfNotNull(audioTrack, videoTrack)
        fun dispose() {
            audioTrack?.dispose()
            videoTrack?.dispose()
        }
    }

    private val peers = ConcurrentHashMap<String, PeerConnection>()
    private val polarities = ConcurrentHashMap<String, Boolean>()
    private val pendingIce = ConcurrentHashMap<String, MutableList<IceCandidate>>()
    private val makingOffer = Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    val peerIds: Set<String> get() = peers.keys

    fun hasPeer(peerId: String): Boolean = peers.containsKey(peerId)

    /**
     * Create the peer connection for [peerId] and attach [localMedia].
     * [polite] is the perfect-negotiation polarity (false = this side initiates).
     * Returns false when the peer already exists (idempotent).
     */
    fun addPeer(peerId: String, localMedia: LocalMedia, polite: Boolean): Boolean {
        if (peers.containsKey(peerId)) return false
        polarities[peerId] = polite
        val pc = createPeerConnection(peerId)
        for (track in localMedia.tracks) {
            pc.addTrack(track)
        }
        return true
    }

    /** Close and forget a peer. */
    fun removePeer(peerId: String) {
        peers.remove(peerId)?.close()
        polarities.remove(peerId)
        pendingIce.remove(peerId)
        makingOffer.remove(peerId)
        events.onPeerClosed(peerId)
    }

    /** Attach an extra local track (e.g. screen share) to a peer and renegotiate. */
    fun addLocalTrack(peerId: String, track: MediaStreamTrack) {
        val pc = peers[peerId] ?: return
        pc.addTrack(track)
        negotiate(peerId)
    }

    /** Initiator role: create an offer and send it once set locally. */
    fun negotiate(peerId: String) {
        val pc = peers[peerId] ?: return
        if (!makingOffer.add(peerId)) return
        pc.createOffer(
            sdpObserver(
                onCreated = { offer ->
                    pc.setLocalDescription(
                        sdpObserver(onSet = { signaling.sendOffer(peerId, offer.toOfferPayload()) },
                            onSetFailure = { makingOffer.remove(peerId) }),
                        offer,
                    )
                },
                onCreatedFailure = { makingOffer.remove(peerId) },
            ),
            MediaConstraints(),
        )
    }

    /** Remote `offer` envelope -> answer (perfect negotiation). */
    fun onRemoteOffer(peerId: String, sdp: String) {
        val pc = peers[peerId] ?: return
        val collision = makingOffer.contains(peerId) || pc.signalingState() != PeerConnection.SignalingState.STABLE
        if (collision && !isPolite(peerId)) return // impolite side defers to the remote offer
        if (collision) {
            // polite side: roll back our pending local offer, then accept the remote one
            pc.setLocalDescription(sdpObserver(), SessionDescription(SessionDescription.Type.ROLLBACK, ""))
        }
        pc.setRemoteDescription(
            sdpObserver(
                onSet = {
                    if (pc.signalingState() == PeerConnection.SignalingState.HAVE_REMOTE_OFFER) {
                        pc.createAnswer(
                            sdpObserver(
                                onCreated = { answer ->
                                    pc.setLocalDescription(
                                        sdpObserver(onSet = { signaling.sendAnswer(peerId, answer.toAnswerPayload()) }),
                                        answer,
                                    )
                                },
                            ),
                            MediaConstraints(),
                        )
                    }
                    drainPendingIce(peerId)
                },
            ),
            SessionDescription(SessionDescription.Type.OFFER, sdp),
        )
    }

    /** Remote `answer` envelope. */
    fun onRemoteAnswer(peerId: String, sdp: String) {
        val pc = peers[peerId] ?: return
        makingOffer.remove(peerId)
        pc.setRemoteDescription(
            sdpObserver(onSet = { drainPendingIce(peerId) }),
            SessionDescription(SessionDescription.Type.ANSWER, sdp),
        )
    }

    /** Remote `ice` envelope (trickle). Queued until the remote description is set. */
    fun onRemoteIce(peerId: String, candidate: String, sdpMid: String?, sdpMLineIndex: Int?) {
        val pc = peers[peerId] ?: return
        val ice = IceCandidate(sdpMid, sdpMLineIndex ?: 0, candidate)
        if (pc.remoteDescription != null) {
            pc.addIceCandidate(ice)
        } else {
            var queue = pendingIce[peerId]
            if (queue == null) {
                queue = CopyOnWriteArrayList()
                val raced = pendingIce.putIfAbsent(peerId, queue)
                if (raced != null) queue = raced
            }
            queue.add(ice)
        }
    }

    fun closeAll() {
        peers.keys.toList().forEach { removePeer(it) }
        makingOffer.clear()
    }

    private fun isPolite(peerId: String): Boolean = polarities[peerId] ?: config.polite

    private fun drainPendingIce(peerId: String) {
        val pc = peers[peerId] ?: return
        val queued = pendingIce.remove(peerId) ?: return
        for (candidate in queued) pc.addIceCandidate(candidate)
    }

    private fun createPeerConnection(peerId: String): PeerConnection {
        val rtcConfig = PeerConnection.RTCConfiguration(config.iceServers.map { it.toWebRtcIceServer() })
        val pc = factory.createPeerConnection(rtcConfig, observer(peerId))
            ?: error("failed to create peer connection for $peerId")
        peers[peerId] = pc
        return pc
    }

    private fun observer(peerId: String): PeerConnection.Observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            events.onIceConnectionState(peerId, state)
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit

        override fun onIceCandidate(candidate: IceCandidate) {
            signaling.sendIce(peerId, candidate.toIcePayload())
        }

        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit

        override fun onAddStream(stream: org.webrtc.MediaStream) = Unit

        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit

        override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit // DataChannelBus: future work

        override fun onRenegotiationNeeded() {
            negotiate(peerId)
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            val track = transceiver.receiver.track() ?: return
            events.onRemoteTrack(peerId, track)
            when (track) {
                is AudioTrack -> events.onRemoteAudioTrack(peerId, track)
                is VideoTrack -> events.onRemoteVideoTrack(peerId, track)
            }
        }
    }

    private fun sdpObserver(
        onCreated: (SessionDescription) -> Unit = {},
        onSet: () -> Unit = {},
        onCreatedFailure: (String) -> Unit = {},
        onSetFailure: (String) -> Unit = {},
    ): SdpObserver = object : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) = onCreated(desc)
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(error: String) = onCreatedFailure(error)
        override fun onSetFailure(error: String) = onSetFailure(error)
    }
}
