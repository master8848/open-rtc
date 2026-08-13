package io.vidcall.client

import io.vidcall.protocol.Envelope
import io.vidcall.protocol.Protocol
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * WebSocket signaling transport.
 *
 * Wire framing: one envelope JSON text frame per message (exactly the schema
 * contract — no wrappers). The relay is expected to expose a room socket per
 * client:
 *
 * ```
 * wss://<baseUrl>/ws?room=<roomId>&session=<sessionId>
 * ```
 *
 * Unicast messages (targetSessionId set) go over a lazy per-target socket:
 *
 * ```
 * wss://<baseUrl>/ws?room=<roomId>&session=<sessionId>&to=<targetSessionId>
 * ```
 *
 * The relay routes frames on a `to=` socket only to that session. Broadcast
 * (target = null) frames go on the room socket. Any relay that supports
 * room + peer routing can implement this convention.
 *
 * Construction is cheap and offline; actual I/O starts on [connect].
 */
class WebSocketTransport(
    baseUrl: String,
    private val roomId: String,
    private val sessionId: String,
    private val extraHeaders: Map<String, String> = emptyMap(),
    private val client: OkHttpClient = WebSocketTransport.defaultClient(),
    private val json: Json = Protocol.json,
) : SignalingTransport {

    private val base: HttpUrl = baseUrl.toHttpUrl()

    @Volatile private var listener: TransportListener? = null
    private var roomSocket: WebSocket? = null
    private val pairSockets = ConcurrentHashMap<String, WebSocket>()

    override fun connect(listener: TransportListener) {
        check(this.listener == null) { "transport already connected" }
        this.listener = listener
        listener.onState(TransportState.CONNECTING)
        roomSocket = openSocket(target = null)
    }

    override fun send(envelope: Envelope, targetSessionId: String?) {
        val text = json.encodeToString(Envelope.serializer(), envelope)
        val sent = if (targetSessionId == null) {
            roomSocket?.send(text) ?: throw IllegalStateException("transport not connected")
        } else {
            val socket = pairSockets.computeIfAbsent(targetSessionId) { openSocket(targetSessionId) }
            socket.send(text)
        }
        if (!sent) throw IOException("WebSocket send failed (socket closed)")
    }

    override fun close() {
        listener = null
        roomSocket?.close(1000, "client close")
        roomSocket = null
        pairSockets.values.forEach { it.close(1000, "client close") }
        pairSockets.clear()
        client.dispatcher.executorService.shutdown()
    }

    private fun openSocket(target: String?): WebSocket =
        client.newWebSocket(
            buildRequest(target),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (target == null) listener?.onState(TransportState.CONNECTED)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        // Tolerant decode per schema.json wire rules: unknown `type`
                        // values are ignored + logged (forward compatibility — an
                        // additive protocol evolution must not wedge a client);
                        // malformed frames still surface as a failure.
                        val envelope = Protocol.decodeEnvelopeOrNull(text)
                        if (envelope != null) {
                            listener?.onMessage(envelope)
                        }
                    } catch (e: Exception) {
                        listener?.onFailure(IOException("invalid envelope frame", e))
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (target == null) listener?.onState(TransportState.DISCONNECTED)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (target == null) listener?.onFailure(t) else pairSockets.remove(target)
                }
            },
        )

    private fun buildRequest(target: String?): Request {
        val url = base.newBuilder()
            .addQueryParameter("room", roomId)
            .addQueryParameter("session", sessionId)
            .apply { if (target != null) addQueryParameter("to", target) }
            .build()
        val builder = Request.Builder().url(url)
        extraHeaders.forEach { (k, v) -> builder.header(k, v) }
        return builder.build()
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS) // WS keepalive
            .build()
    }
}
