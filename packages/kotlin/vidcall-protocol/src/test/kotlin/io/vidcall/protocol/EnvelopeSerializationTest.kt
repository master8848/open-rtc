package io.vidcall.protocol

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Protocol serialization conformance (L0): the three canonical sample envelopes
 * must round-trip byte-for-byte semantically, and typed payload decoding must
 * match schema.json. Offline-runnable: no network, no Android runtime.
 */
class EnvelopeSerializationTest {

    private val json = Protocol.json

    private fun fixture(name: String): String {
        val path = "envelopes/$name.json"
        val url = javaClass.classLoader.getResource(path)
            ?: Thread.currentThread().contextClassLoader?.getResource(path)
            ?: ClassLoader.getSystemResource(path)
        return checkNotNull(url) { "missing fixture $name" }.readText()
    }

    private fun roundTrip(sample: Envelope, fixtureName: String): Envelope {
        val encoded = json.encodeToString(Envelope.serializer(), sample)
        val fromFixture = json.decodeFromString(Envelope.serializer(), fixture(fixtureName))
        assertEquals("re-encoding must equal fixture encoding", json.encodeToString(Envelope.serializer(), fromFixture), encoded)
        val decoded = json.decodeFromString(Envelope.serializer(), encoded)
        assertEquals("round-trip must preserve the envelope", sample, decoded)
        return decoded
    }

    @Test
    fun `join envelope round-trips`() {
        val decoded = roundTrip(SampleEnvelopes.join, "sample-join")
        assertEquals(1, decoded.v)
        assertEquals(MessageType.JOIN, decoded.type)
        assertEquals("room-42", decoded.roomId)
        assertEquals("user-ada", decoded.senderId)
        assertEquals("sess-abc-0001", decoded.sessionId)
        assertTrue(decoded.payload["displayName"] is JsonPrimitive)
    }

    @Test
    fun `offer envelope round-trips`() {
        val decoded = roundTrip(SampleEnvelopes.offer, "sample-offer")
        assertEquals(MessageType.OFFER, decoded.type)
        val payload = decoded.payload.decodeAsPayload<OfferPayload>()
        assertEquals("main", payload.label)
        assertTrue(payload.sdp.startsWith("v=0"))
        assertTrue(payload.sdp.contains("a=rtpmap:96 VP8/90000"))
    }

    @Test
    fun `ice envelope round-trips`() {
        val decoded = roundTrip(SampleEnvelopes.ice, "sample-ice")
        assertEquals(MessageType.ICE, decoded.type)
        val payload = decoded.payload.decodeAsPayload<IcePayload>()
        assertEquals("0", payload.sdpMid)
        assertEquals(0, payload.sdpMLineIndex)
        assertTrue(payload.candidate.startsWith("candidate:842163049"))
    }

    @Test
    fun `join payload decodes to typed schema fields`() {
        val payload = SampleEnvelopes.join.payload.decodeAsPayload<JoinPayload>()
        assertEquals("Ada Lovelace", payload.displayName)
        assertEquals("pro", payload.metadata["tier"]?.jsonPrimitive?.content)
        val dp = checkNotNull(payload.deviceProfile)
        assertEquals(8, dp.hardwareConcurrency)
        assertEquals(false, dp.mobile)
        assertEquals(8.0, dp.deviceMemory)
        assertEquals(DevicePlatform.KOTLIN, dp.platform)
        assertEquals(listOf("VP8", "H264"), payload.capabilities?.codecs)
    }

    @Test
    fun `answer uses the offer payload shape`() {
        val answer = AnswerPayload(sdp = "v=0\r\ns=-\r\nt=0 0", label = "main")
        val obj = answer.encodeAsPayload()
        val decoded = obj.decodeAsPayload<OfferPayload>() // schema: answer -> OfferPayload
        assertEquals(answer.sdp, decoded.sdp)
        assertEquals(answer.label, decoded.label)
    }

    @Test
    fun `missing required field fails to decode`() {
        val broken = fixture("sample-offer").replace("\"type\": \"offer\"", "\"roomId\": \"x\"")
        assertThrows(SerializationException::class.java) {
            json.decodeFromString(Envelope.serializer(), broken)
        }
    }

    @Test
    fun `unknown envelope type fails to decode`() {
        val broken = fixture("sample-join").replace("\"join\"", "\"teleport\"")
        assertThrows(SerializationException::class.java) {
            json.decodeFromString(Envelope.serializer(), broken)
        }
    }

    @Test
    fun `unknown payload fields are ignored (forward compatibility)`() {
        val future = fixture("sample-join").replace(
            "\"displayName\": \"Ada Lovelace\"",
            "\"displayName\": \"Ada Lovelace\", \"futureField\": 123",
        )
        val decoded = json.decodeFromString(Envelope.serializer(), future)
        assertEquals("Ada Lovelace", decoded.payload.decodeAsPayload<JoinPayload>().displayName)
    }

    @Test
    fun `nullable payload fields are omitted from the wire`() {
        val payload = IcePayload(candidate = "candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid = null, sdpMLineIndex = null)
        val encoded = json.encodeToString(Envelope.serializer(), Envelope(
            type = MessageType.ICE, roomId = "r", senderId = "s", sessionId = "se", ts = 1, seq = 1,
            payload = payload.encodeAsPayload(),
        ))
        assertTrue("sdpMid must be omitted when null", !encoded.contains("sdpMid"))
        assertTrue("sdpMLineIndex must be omitted when null", !encoded.contains("sdpMLineIndex"))
    }

    @Test
    fun `sample envelope set covers the three schema sections`() {
        // every sample decodes as a valid envelope and is present as a fixture
        val names = listOf("sample-join", "sample-offer", "sample-ice")
        names.forEach { assertNotNull(it, javaClass.classLoader.getResource("envelopes/$it.json")) }
        assertEquals(3, SampleEnvelopes.all.size)
    }
}
