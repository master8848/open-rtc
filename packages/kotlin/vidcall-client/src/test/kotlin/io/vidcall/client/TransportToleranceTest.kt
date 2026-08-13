package io.vidcall.client

import io.vidcall.protocol.ChatPayload
import io.vidcall.protocol.Envelope
import io.vidcall.protocol.MessageType
import io.vidcall.protocol.Protocol
import io.vidcall.protocol.decodeAsPayload
import io.vidcall.protocol.encodeAsPayload
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wire-level transport tolerance tests: the schema.json rule "unknown `type`
 * values are ignored + logged (clients MUST NOT fail decode)" must hold in
 * the transport loops themselves, not just in the L0 codec suite. A future
 * protocol version adding a new envelope type must not wedge a connected
 * client (WebSocket) or a poll loop (REST relay).
 */
class TransportToleranceTest {

    private val server = MockWebServer()
    private val json: Json = Protocol.json

    private val unknownTypeFrame: String = json.encodeToString(
        Envelope.serializer(),
        Envelope(
            type = MessageType.CHAT, // placeholder; raw text below overrides the type
            roomId = "room-42", senderId = "user-ada", sessionId = "sess-abc-0001",
            ts = 1L, seq = 1L,
        ),
    ).replace("\"chat\"", "\"teleport\"")

    private val chatFrame: String = json.encodeToString(
        Envelope.serializer(),
        Envelope(
            type = MessageType.CHAT, roomId = "room-42", senderId = "user-ada",
            sessionId = "sess-abc-0001", ts = 2L, seq = 2L,
            payload = ChatPayload(text = "hi room").encodeAsPayload(),
        ),
    )

    @After
    fun tearDown() {
        server.close()
    }

    // ------------------------------------------------------------- WebSocket

    @Test
    fun `websocket skips an unknown-type frame and delivers valid ones`() {
        server.start()
        server.enqueue(
            MockResponse.Builder()
                .webSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        // unknown type first (must be skipped + logged, not a failure)
                        webSocket.send(unknownTypeFrame)
                        webSocket.send(chatFrame)
                    }

                    // OkHttp close-handshake contract: respond to a peer's close
                    // frame so the connection (and the mock server) can shut down.
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, reason)
                    }
                })
                .build(),
        )

        val delivered = mutableListOf<Envelope>()
        val failures = mutableListOf<Throwable>()
        val received = CountDownLatch(1)
        val transport = WebSocketTransport(baseUrl = server.url("/").toString(), roomId = "room-42", sessionId = "sess-1")
        transport.connect(object : TransportListener {
            override fun onMessage(envelope: Envelope) {
                delivered.add(envelope)
                received.countDown()
            }

            override fun onFailure(error: Throwable) {
                failures.add(error)
            }
        })

        assertTrue("valid chat envelope must be delivered", received.await(5, TimeUnit.SECONDS))
        transport.close()

        assertEquals("unknown-type frame skipped, valid one delivered", 1, delivered.size)
        assertEquals(MessageType.CHAT, delivered.single().type)
        assertEquals("hi room", delivered.single().payload.decodeAsPayload<ChatPayload>().text)
        assertTrue("unknown-type frame must not surface as a failure: $failures", failures.isEmpty())
    }

    @Test
    fun `websocket malformed frame still surfaces as a failure`() {
        server.start()
        server.enqueue(
            MockResponse.Builder()
                .webSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        webSocket.send("{not json")
                    }
                })
                .build(),
        )

        val failures = mutableListOf<Throwable>()
        val failed = CountDownLatch(1)
        val transport = WebSocketTransport(baseUrl = server.url("/").toString(), roomId = "room-42", sessionId = "sess-1")
        transport.connect(object : TransportListener {
            override fun onFailure(error: Throwable) {
                failures.add(error)
                failed.countDown()
            }
        })

        assertTrue("malformed frame must surface as a failure", failed.await(5, TimeUnit.SECONDS))
        transport.close()
        assertEquals(1, failures.size)
    }

    // ----------------------------------------------------------------- REST

    @Test
    fun `rest poll skips an unknown-type envelope and delivers valid ones`() {
        server.start()
        // Poll 1: unknown type (id 1, must be skipped) + valid chat (id 2).
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .body(
                    """
                    {"messages":[
                      {"id":1,"envelope":{"v":1,"type":"teleport","roomId":"room-42","senderId":"user-ada","sessionId":"sess-abc-0001","ts":1,"seq":1,"payload":{}}},
                      {"id":2,"envelope":$chatFrame}
                    ]}
                    """.trimIndent(),
                )
                .build(),
        )
        // Poll 2: next chat (id 3) — proves the cursor advanced past the skipped envelope.
        val secondChatFrame = json.encodeToString(
            Envelope.serializer(),
            Envelope(
                type = MessageType.CHAT, roomId = "room-42", senderId = "user-ada",
                sessionId = "sess-abc-0001", ts = 3L, seq = 3L,
                payload = ChatPayload(text = "after").encodeAsPayload(),
            ),
        )
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .body(
                    """
                    {"messages":[
                      {"id":3,"envelope":$secondChatFrame}
                    ]}
                    """.trimIndent(),
                )
                .build(),
        )

        val delivered = mutableListOf<Envelope>()
        val failures = mutableListOf<Throwable>()
        val received = CountDownLatch(2)
        val transport = RestTransport(
            baseUrl = server.url("/").toString(),
            roomId = "room-42",
            sessionId = "sess-1",
            pollIntervalMillis = 50L,
        )
        transport.connect(object : TransportListener {
            override fun onMessage(envelope: Envelope) {
                delivered.add(envelope)
                received.countDown()
            }

            override fun onFailure(error: Throwable) {
                failures.add(error)
                received.countDown()
            }
        })

        assertTrue("valid chat envelopes must be delivered (failures: $failures)", received.await(5, TimeUnit.SECONDS))
        transport.close()

        assertEquals("unknown-type envelope skipped, valid ones delivered (failures: $failures)", 2, delivered.size)
        assertEquals(listOf("hi room", "after"), delivered.map { it.payload.decodeAsPayload<ChatPayload>().text })
        assertTrue("unknown-type envelope must not surface as a failure: $failures", failures.isEmpty())

        val first = server.takeRequest()
        assertEquals("initial poll starts at the cursor 0", "0", first.url.queryParameter("afterSeq"))
        val second = server.takeRequest()
        assertEquals("poll cursor must advance past the skipped envelope", "2", second.url.queryParameter("afterSeq"))
    }
}
