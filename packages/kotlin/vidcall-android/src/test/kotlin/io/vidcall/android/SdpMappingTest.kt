package io.vidcall.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.IceCandidate
import org.webrtc.SessionDescription

/**
 * JVM unit tests for the org.webrtc <-> wire payload mappings.
 * org.webrtc value objects (SessionDescription, IceCandidate) are plain data
 * holders, so these run offline without an Android runtime.
 */
class SdpMappingTest {

    private val sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0"

    @Test
    fun `offer description maps to OfferPayload`() {
        val payload = SessionDescription(SessionDescription.Type.OFFER, sdp).toOfferPayload(label = "main")
        assertEquals(sdp, payload.sdp)
        assertEquals("main", payload.label)
    }

    @Test
    fun `answer description maps to AnswerPayload`() {
        val payload = SessionDescription(SessionDescription.Type.ANSWER, sdp).toAnswerPayload()
        assertEquals(sdp, payload.sdp)
    }

    @Test
    fun `ice candidate maps to IcePayload`() {
        val candidate = "candidate:842163049 1 udp 1677729535 192.168.1.10 53520 typ srflx raddr 0.0.0.0 rport 0 generation 0"
        val payload = IceCandidate("0", 0, candidate).toIcePayload()
        assertEquals(candidate, payload.candidate)
        assertEquals("0", payload.sdpMid)
        assertEquals(0, payload.sdpMLineIndex)
    }

    @Test
    fun `glare polarity follows the schema rule polite = selfId less than remoteId`() {
        assertTrue(isPolite("user-ada", "user-bob"))
        assertFalse(isPolite("user-bob", "user-ada"))
        assertFalse(isPolite("user-ada", "user-ada"))
    }
}
