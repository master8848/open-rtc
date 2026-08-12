package io.vidcall.android

import org.webrtc.PeerConnection

/**
 * STUN/TURN server configuration for WebRTC peer connections.
 */
data class IceServerConfig(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
) {
    fun toWebRtcIceServer(): PeerConnection.IceServer {
        val builder = PeerConnection.IceServer.builder(urls)
        if (username != null) builder.setUsername(username)
        if (credential != null) builder.setPassword(credential)
        return builder.createIceServer()
    }
}

/**
 * WebRTC wiring configuration for [PeerConnectionManager] / [VidcallRtcClient].
 */
data class RtcConfig(
    /** STUN/TURN servers used when creating peer connections. */
    val iceServers: List<IceServerConfig> = emptyList(),
    /**
     * Default perfect-negotiation polarity for peers whose polarity is not
     * derivable from the deterministic schema rule (`polite = selfId <
     * remoteId`, lexicographic — see [io.vidcall.android.isPolite]).
     * `true` = polite (answers offers, never fights for the offer).
     */
    val polite: Boolean = true,
)
