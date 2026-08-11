package io.vidcall.client

import io.vidcall.protocol.Envelope
import io.vidcall.protocol.Protocol
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * REST relay signaling transport (backend-agnostic HTTP mapping of the same
 * schema.json envelope contract). Expected relay endpoints:
 *
 * ```
 * POST {base}/v1/rooms/{roomId}/messages            # broadcast (target = null)
 * POST {base}/v1/rooms/{roomId}/messages/{target}   # unicast to a session
 * GET  {base}/v1/rooms/{roomId}/messages?afterSeq=N # poll; returns:
 *      {"messages": [{"id": 12, "envelope": {...}}, ...]}
 * ```
 *
 * `id` is the relay's monotonic delivery cursor (NOT part of the protocol);
 * `envelope` is the raw schema.json envelope. The poll loop runs on a daemon
 * thread and emits each envelope via [TransportListener.onMessage].
 */
class RestTransport(
    private val baseUrl: String,
    private val roomId: String,
    private val sessionId: String,
    private val client: OkHttpClient = RestTransport.defaultClient(),
    private val json: Json = Protocol.json,
    private val pollIntervalMillis: Long = 1_000L,
) : SignalingTransport {

    @Serializable
    private data class RelayMessage(val id: Long, val envelope: Envelope)

    @Serializable
    private data class RelayResponse(val messages: List<RelayMessage> = emptyList())

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "vidcall-rest").apply { isDaemon = true }
    }
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    @Volatile private var running = false
    @Volatile private var listener: TransportListener? = null

    override fun connect(listener: TransportListener) {
        check(!running) { "transport already connected" }
        this.listener = listener
        running = true
        listener.onState(TransportState.CONNECTING)
        executor.execute { pollLoop() }
    }

    override fun send(envelope: Envelope, targetSessionId: String?) {
        val body = json.encodeToString(Envelope.serializer(), envelope).toRequestBody(jsonMediaType)
        val path = if (targetSessionId == null) {
            "v1/rooms/${encode(roomId)}/messages"
        } else {
            "v1/rooms/${encode(roomId)}/messages/${encode(targetSessionId)}"
        }
        val request = Request.Builder().url("$baseUrl/$path").post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("emit failed: HTTP ${response.code}")
        }
    }

    override fun close() {
        running = false
        listener = null
        executor.shutdownNow()
        client.dispatcher.executorService.shutdown()
    }

    private fun pollLoop() {
        var afterSeq = 0L
        try {
            while (running) {
                val response = client.newCall(pollRequest(afterSeq)).execute()
                response.use {
                    if (running && response.isSuccessful) {
                        val body = response.body?.string().orEmpty()
                        if (body.isNotBlank()) {
                            val parsed = json.decodeFromString(RelayResponse.serializer(), body)
                            for (message in parsed.messages) {
                                if (!running) break
                                afterSeq = maxOf(afterSeq, message.id)
                                listener?.onMessage(message.envelope)
                            }
                        }
                    }
                }
                if (running) Thread.sleep(pollIntervalMillis)
            }
        } catch (e: Exception) {
            if (running) {
                listener?.onFailure(e)
                listener?.onState(TransportState.FAILED)
            }
        } finally {
            running = false
        }
    }

    private fun pollRequest(afterSeq: Long): Request =
        Request.Builder()
            .url("$baseUrl/v1/rooms/${encode(roomId)}/messages?afterSeq=$afterSeq")
            .build()

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
