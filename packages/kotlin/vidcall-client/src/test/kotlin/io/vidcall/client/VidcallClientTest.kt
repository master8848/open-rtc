package io.vidcall.client

import io.vidcall.protocol.ChatPayload
import io.vidcall.protocol.DevicePlatform
import io.vidcall.protocol.DeviceProfile
import io.vidcall.protocol.Envelope
import io.vidcall.protocol.MessageType
import io.vidcall.protocol.OfferPayload
import io.vidcall.protocol.PresenceState
import io.vidcall.protocol.ScreenShareAction
import io.vidcall.protocol.decodeAsPayload
import io.vidcall.protocol.encodeAsPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VidcallClientTest {

    private val config = VidcallConfig(roomId = "room-42", clientId = "user-ada", sessionId = "sess-1")

    private fun client(listener: VidcallEventListener? = null, transport: FakeTransport = FakeTransport()) =
        VidcallClient(config, transport, listener ?: object : VidcallEventListener {}, now = { 1_786_000_000_000L })

    // ------------------------------------------------------------------ join

    @Test
    fun `join emits a JOIN envelope with typed payload`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.join(
            displayName = "Ada",
            deviceProfile = DeviceProfile(hardwareConcurrency = 8, mobile = false, platform = DevicePlatform.KOTLIN),
        )

        val (envelope, target) = t.sent.single()
        assertEquals(null, target)
        assertEquals(MessageType.JOIN, envelope.type)
        assertEquals("room-42", envelope.roomId)
        assertEquals("user-ada", envelope.senderId)
        assertEquals("sess-1", envelope.sessionId)
        assertEquals(1L, envelope.seq)
        assertEquals(1_786_000_000_000L, envelope.ts)
        val payload = envelope.payload.decodeAsPayload<io.vidcall.protocol.JoinPayload>()
        assertEquals("Ada", payload.displayName)
        assertEquals(DevicePlatform.KOTLIN, payload.deviceProfile?.platform)
    }

    @Test
    fun `seq is monotonic across sends`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.join()
        c.leave()
        c.join()
        assertEquals(listOf(1L, 2L, 3L), t.sent.map { it.first.seq })
    }

    // ------------------------------------------------------------------ chat / reaction / screen share

    @Test
    fun `chat emits a CHAT envelope with replyTo`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.sendChat("hello room", replyTo = io.vidcall.protocol.ChatReplyTo("user-bob", 7L))

        val envelope = t.sent.single().first
        assertEquals(MessageType.CHAT, envelope.type)
        val payload = envelope.payload.decodeAsPayload<ChatPayload>()
        assertEquals("hello room", payload.text)
        assertEquals("user-bob", payload.replyTo?.senderId)
        assertEquals(7L, payload.replyTo?.seq)
    }

    @Test
    fun `chat over schema maxLength throws`() {
        val c = client()
        assertThrows(IllegalArgumentException::class.java) {
            c.sendChat("x".repeat(4001))
        }
    }

    @Test
    fun `reaction emits a REACTION envelope`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.sendReaction("\uD83D\uDE00", targetSenderId = "user-bob")
        val envelope = t.sent.single().first
        assertEquals(MessageType.REACTION, envelope.type)
        val payload = envelope.payload.decodeAsPayload<io.vidcall.protocol.ReactionPayload>()
        assertEquals("\uD83D\uDE00", payload.emoji)
        assertEquals("user-bob", payload.targetSenderId)
    }

    @Test
    fun `screenShare start and stop emit SCREEN_SHARE`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.screenShare(start = true, label = "screen")
        c.screenShare(start = false)
        assertEquals(
            listOf(ScreenShareAction.START, ScreenShareAction.STOP),
            t.sent.map { it.first.payload.decodeAsPayload<io.vidcall.protocol.ScreenSharePayload>().action },
        )
    }

    // ------------------------------------------------------------------ presence / webrtc signaling

    @Test
    fun `presence emits a PRESENCE envelope`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.sendPresence(PresenceState.BUSY)
        val payload = t.sent.single().first.payload.decodeAsPayload<io.vidcall.protocol.PresencePayload>()
        assertEquals(PresenceState.BUSY, payload.state)
    }

    @Test
    fun `offer answer and ice carry the targetSessionId routing hint`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.sendOffer("v=0 sdp offer", label = "main", targetSessionId = "sess-bob")
        c.sendAnswer("v=0 sdp answer", targetSessionId = "sess-bob")
        c.sendIce("candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid = "0", sdpMLineIndex = 0, targetSessionId = "sess-bob")

        val (offer, target1) = t.sent[0]
        assertEquals(MessageType.OFFER, offer.type)
        assertEquals("sess-bob", target1)
        assertEquals("main", offer.payload.decodeAsPayload<OfferPayload>().label)
        assertEquals("sess-bob", t.sent[1].second)
        assertEquals("sess-bob", t.sent[2].second)
    }

    // ------------------------------------------------------------------ incoming dispatch

    @Test
    fun `incoming chat dispatches to typed listener`() {
        var received: String? = null
        var from: String? = null
        val t = FakeTransport()
        val c = client(listener = object : VidcallEventListener {
            override fun onChat(senderId: String, payload: ChatPayload, envelope: Envelope) {
                from = senderId
                received = payload.text
            }
        }, transport = t)
        c.connect()
        t.receive(chatEnvelope("user-bob", "hey ada", seq = 10L))
        assertEquals("user-bob", from)
        assertEquals("hey ada", received)
    }

    @Test
    fun `duplicate senderId+seq is delivered once`() {
        var count = 0
        val t = FakeTransport()
        val c = client(listener = object : VidcallEventListener {
            override fun onChat(senderId: String, payload: ChatPayload, envelope: Envelope) {
                count++
            }
        }, transport = t)
        c.connect()
        val envelope = chatEnvelope("user-bob", "dup", seq = 5L)
        t.receive(envelope)
        t.receive(envelope)
        assertEquals(1, count)
    }

    @Test
    fun `ping is answered with a pong`() {
        val t = FakeTransport()
        val c = client(transport = t)
        c.connect()
        t.receive(Envelope(
            type = MessageType.PING, roomId = "room-42", senderId = "user-bob", sessionId = "sess-bob",
            ts = 1L, seq = 1L,
        ))
        val pong = t.sent.single().first
        assertEquals(MessageType.PONG, pong.type)
        assertEquals("user-ada", pong.senderId)
        assertEquals("sess-1", pong.sessionId)
    }

    @Test
    fun `unknown protocol version reports an error envelope`() {
        var errorCode: String? = null
        val t = FakeTransport()
        val c = client(listener = object : VidcallEventListener {
            override fun onError(payload: io.vidcall.protocol.ErrorPayload, envelope: Envelope?) {
                errorCode = payload.code
            }
        }, transport = t)
        c.connect()
        t.receive(Envelope(
            v = 99, type = MessageType.CHAT, roomId = "room-42", senderId = "user-bob", sessionId = "sess-bob",
            ts = 1L, seq = 1L,
        ))
        assertEquals("protocol-version", errorCode)
    }

    // ------------------------------------------------------------------ helpers

    private fun chatEnvelope(senderId: String, text: String, seq: Long): Envelope =
        Envelope(
            type = MessageType.CHAT,
            roomId = "room-42",
            senderId = senderId,
            sessionId = "sess-$senderId",
            ts = 2L,
            seq = seq,
            payload = ChatPayload(text).encodeAsPayload(),
        )
}
