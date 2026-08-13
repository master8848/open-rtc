package io.vidcall.protocol

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * L0 conformance suite over the CANONICAL wire fixtures in
 * `protocol/fixtures/` (single source of truth; the same files are parsed by
 * the Swift, Dart, and TS-core conformance suites). The directory is exposed
 * as a test-resource dir by build.gradle.kts, so the tests read the SAME
 * bytes as every other binding.
 */
class EnvelopeSerializationTest {

    private val json = Protocol.json

    /** Every canonical fixture name (protocol/fixtures, without the .json suffix). */
    private val fixtureNames: List<String> = listOf(
        "join", "leave", "offer", "answer", "ice", "presence", "reaction", "chat",
        "screen-share", "quality-warning", "sfu", "error", "ping", "pong",
        "join-targeted", "leave-targeted", "offer-targeted", "answer-targeted",
        "ice-targeted", "presence-targeted", "reaction-targeted", "chat-targeted",
    )

    private val allMessageTypes: Set<MessageType> = setOf(
        MessageType.JOIN, MessageType.LEAVE, MessageType.OFFER, MessageType.ANSWER,
        MessageType.ICE, MessageType.PRESENCE, MessageType.REACTION, MessageType.CHAT,
        MessageType.SCREEN_SHARE, MessageType.QUALITY_WARNING, MessageType.SFU,
        MessageType.ERROR, MessageType.PING, MessageType.PONG,
    )

    private fun fixture(name: String): String {
        val resource = javaClass.classLoader?.getResource("$name.json")
            ?: ClassLoader.getSystemResource("$name.json")
        val text = resource?.readText()
        return checkNotNull(text) { "missing canonical fixture $name.json (protocol/fixtures)" }
    }

    private fun typeFor(name: String): MessageType = when (name.substringBefore("-targeted")) {
        "join" -> MessageType.JOIN
        "leave" -> MessageType.LEAVE
        "offer" -> MessageType.OFFER
        "answer" -> MessageType.ANSWER
        "ice" -> MessageType.ICE
        "presence" -> MessageType.PRESENCE
        "reaction" -> MessageType.REACTION
        "chat" -> MessageType.CHAT
        "screen-share" -> MessageType.SCREEN_SHARE
        "quality-warning" -> MessageType.QUALITY_WARNING
        "sfu" -> MessageType.SFU
        "error" -> MessageType.ERROR
        "ping" -> MessageType.PING
        "pong" -> MessageType.PONG
        else -> error("no MessageType for fixture $name")
    }

    // --- canonical-fixture conformance --------------------------------------

    @Test
    fun `all canonical fixtures decode with correct headers and byte-round-trip`() {
        for (name in fixtureNames) {
            val text = fixture(name)
            val decoded = json.decodeFromString(Envelope.serializer(), text)
            assertEquals("$name: v", 1, decoded.v)
            assertEquals("$name: type", typeFor(name), decoded.type)
            assertEquals("$name: roomId", "room-42", decoded.roomId)
            assertTrue("$name: senderId set", decoded.senderId.startsWith("user-"))
            assertTrue("$name: sessionId set", decoded.sessionId.startsWith("sess-"))
            assertTrue("$name: seq is 0-based (>= 0)", decoded.seq >= 0)
            // semantic JSON equality: re-encoding must reproduce the canonical bytes
            val reencoded = json.encodeToString(Envelope.serializer(), decoded)
            assertEquals(
                "$name: re-encode == fixture bytes",
                json.parseToJsonElement(text),
                json.parseToJsonElement(reencoded),
            )
            // object round-trip stability
            assertEquals(decoded, json.decodeFromString(Envelope.serializer(), reencoded))
        }
    }

    @Test
    fun `fixtures cover every schema envelope type`() {
        val covered = fixtureNames.map { typeFor(it) }.toSet()
        assertEquals(allMessageTypes, covered)
    }

    @Test
    fun `targeted fixtures carry targetSenderId and broadcast fixtures do not`() {
        for (name in fixtureNames) {
            val decoded = json.decodeFromString(Envelope.serializer(), fixture(name))
            if (name.endsWith("-targeted")) {
                assertEquals("$name: targetSenderId", "user-ada", decoded.targetSenderId)
            } else {
                assertNull("$name: no targetSenderId", decoded.targetSenderId)
            }
        }
    }

    @Test
    fun `ping and pong omit the payload key on the wire`() {
        for (name in listOf("ping", "pong")) {
            val text = fixture(name)
            assertFalse("$name: fixture has no payload key", text.contains("\"payload\""))
            val decoded = json.decodeFromString(Envelope.serializer(), text)
            assertTrue("$name: empty payload", decoded.payload.isEmpty())
            val reencoded = json.encodeToString(Envelope.serializer(), decoded)
            assertFalse("$name: re-encode omits payload key", reencoded.contains("\"payload\""))
        }
    }

    // --- typed payload decoding ----------------------------------------------

    @Test
    fun `join envelope decodes the full device profile and capabilities`() {
        val envelope = json.decodeFromString(Envelope.serializer(), fixture("join"))
        assertEquals(MessageType.JOIN, envelope.type)
        val join = envelope.payload.decodeAsPayload<JoinPayload>()
        assertEquals("Ada Lovelace", join.displayName)
        assertEquals("pro", join.metadata["tier"]?.jsonPrimitive?.content)
        assertEquals("en", join.metadata["locale"]?.jsonPrimitive?.content)
        assertEquals(8, join.deviceProfile?.hardwareConcurrency)
        assertEquals(8.0, join.deviceProfile?.deviceMemory!!, 0.0)
        assertEquals(false, join.deviceProfile?.mobile)
        assertEquals(1920, join.deviceProfile?.screenWidth)
        assertEquals(1080, join.deviceProfile?.screenHeight)
        assertEquals(DevicePlatform.BROWSER, join.deviceProfile?.platform)
        assertEquals(listOf("VP8", "H264"), join.capabilities?.codecs)
        assertEquals(true, join.capabilities?.simulcast)
    }

    @Test
    fun `offer envelope decodes and round-trips an SDP`() {
        val envelope = json.decodeFromString(Envelope.serializer(), fixture("offer"))
        assertEquals(MessageType.OFFER, envelope.type)
        val offer = envelope.payload.decodeAsPayload<OfferPayload>()
        assertEquals("main", offer.label)
        assertTrue(offer.sdp.startsWith("v=0"))
        assertTrue(offer.sdp.contains("a=rtpmap:96 VP8/90000"))
        val decoded = json.decodeFromString(Envelope.serializer(), fixture("offer"))
        assertEquals(decoded, json.decodeFromString(Envelope.serializer(), json.encodeToString(Envelope.serializer(), decoded)))
    }

    @Test
    fun `answer uses the offer payload shape`() {
        val answer = json.decodeFromString(Envelope.serializer(), fixture("answer"))
        val payload = answer.payload.decodeAsPayload<OfferPayload>()
        assertEquals("main", payload.label)
        assertTrue(payload.sdp.startsWith("v=0"))
        assertTrue(payload.sdp.contains("a=recvonly"))
    }

    @Test
    fun `ice envelope decodes candidate, sdpMid and sdpMLineIndex`() {
        val ice = json.decodeFromString(Envelope.serializer(), fixture("ice"))
        val payload = ice.payload.decodeAsPayload<IcePayload>()
        assertTrue(payload.candidate.startsWith("candidate:842163049"))
        assertEquals("0", payload.sdpMid)
        assertEquals(0, payload.sdpMLineIndex)
    }

    @Test
    fun `unknown fields are ignored`() {
        val envelope = json.decodeFromString(
            Envelope.serializer(),
            """{"v":1,"type":"chat","roomId":"r","senderId":"a","sessionId":"s","ts":1,"seq":0,"payload":{"text":"hi","futureField":42}}""",
        )
        assertEquals("hi", envelope.payload.decodeAsPayload<ChatPayload>().text)
    }

    @Test
    fun `missing required envelope fields throw`() {
        try {
            json.decodeFromString(Envelope.serializer(), """{"v":1,"type":"chat","roomId":"r"}""")
            fail("expected SerializationException for missing senderId/sessionId/ts/seq")
        } catch (_: SerializationException) {
            // expected
        }
    }

    @Test
    fun `nullable payload fields are omitted when null`() {
        val envelope = json.decodeFromString(
            Envelope.serializer(),
            """{"v":1,"type":"reaction","roomId":"r","senderId":"a","sessionId":"s","ts":1,"seq":0,"payload":{"emoji":"x"}}""",
        )
        val reencoded = json.encodeToString(Envelope.serializer(), envelope)
        assertFalse(reencoded.contains("\"targetSenderId\""))
    }

    @Test
    fun `chat and reaction round-trip`() {
        val chat = json.decodeFromString(Envelope.serializer(), fixture("chat"))
        assertEquals("hello room", chat.payload.decodeAsPayload<ChatPayload>().text)
        val reaction = json.decodeFromString(Envelope.serializer(), fixture("reaction"))
        assertEquals("🎉", reaction.payload.decodeAsPayload<ReactionPayload>().emoji)
    }

    // --- wire rules from schema.json -----------------------------------------

    @Test
    fun `unknown envelope types are ignored and logged instead of throwing`() {
        // schema.json: "unknown `type` values are ignored + logged (clients MUST NOT
        // fail decode)". A future protocol version may add envelope types; the
        // binding must skip them, not crash.
        val future = """
            {"v":1,"type":"teleport","roomId":"room-42","senderId":"user-ada",
             "sessionId":"sess-abc-0001","ts":1786000007000,"seq":14,"payload":{}}
        """.trimIndent()
        assertNull("unknown type must be ignored (null), not thrown", Protocol.decodeEnvelopeOrNull(future))
        // the strict codec still rejects unknown types (callers that need forward
        // compatibility must use the tolerant path above)
        try {
            json.decodeFromString(Envelope.serializer(), future)
            fail("strict decode must reject an unknown envelope type")
        } catch (_: SerializationException) {
            // expected
        }
        // known types flow through the tolerant path unchanged
        val chat = checkNotNull(Protocol.decodeEnvelopeOrNull(fixture("chat")))
        assertEquals("hello room", chat.payload.decodeAsPayload<ChatPayload>().text)
    }

    @Test
    fun `glare polarity rule polite = selfId less than remoteId matches the canonical peers`() {
        // schema.json: "every binding MUST derive the same polarity —
        // `polite = selfId < remoteId` (lexicographic string comparison of
        // `senderId`)". The canonical fixtures use ada (user-ada) and bob
        // (user-bob); the Kotlin implementation lives in vidcall-android
        // (io.vidcall.android.isPolite) — this pins the shared rule here.
        fun isPolite(selfId: String, remoteId: String): Boolean = selfId < remoteId
        assertTrue(isPolite("user-ada", "user-bob"))
        assertFalse(isPolite("user-bob", "user-ada"))
        assertFalse("a peer is never polite with itself", isPolite("user-ada", "user-ada"))
        // and the fixture identities actually order this way
        val ada = json.decodeFromString(Envelope.serializer(), fixture("join"))
        val bob = json.decodeFromString(Envelope.serializer(), fixture("join-targeted"))
        assertTrue(ada.senderId < bob.senderId)
        assertEquals("user-ada", ada.senderId)
        assertEquals("user-bob", bob.senderId)
    }
}
