package io.vidcall.client

/**
 * Identity + room configuration for a [VidcallClient].
 *
 * These values populate the required wire fields of every sent envelope
 * (`roomId`, `senderId`, `sessionId`). The transport (WebSocket/REST URL and
 * channel details) is configured on the transport itself — the client is
 * backend-agnostic and only ever speaks the schema.json envelope.
 */
data class VidcallConfig(
    /** Schema `roomId`: the room the client joins (one channel per room). */
    val roomId: String,
    /** Schema `senderId`: stable identity of this client. */
    val clientId: String,
    /** Schema `sessionId`: fresh value per join so reconnects/rejoins are distinct. */
    val sessionId: String,
) {
    init {
        require(roomId.isNotBlank()) { "roomId must not be blank" }
        require(clientId.isNotBlank()) { "clientId must not be blank" }
        require(sessionId.isNotBlank()) { "sessionId must not be blank" }
    }
}
