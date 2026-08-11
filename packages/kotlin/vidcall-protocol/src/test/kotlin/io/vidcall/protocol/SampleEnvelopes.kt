package io.vidcall.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The canonical L0 conformance fixtures, derived 1:1 from `protocol/schema.json`.
 *
 * These three envelopes (join / offer / ice) are the same JSON documents shipped
 * in `src/test/resources/envelopes/`; every language binding runs the shared
 * conformance suite against them (see docs/research/mobile-bindings.md §4 and
 * README.md "Protocol conformance (L0)").
 */
object SampleEnvelopes {

    val join: Envelope = Envelope(
        v = 1,
        type = MessageType.JOIN,
        roomId = "room-42",
        senderId = "user-ada",
        sessionId = "sess-abc-0001",
        ts = 1_786_000_000_000L,
        seq = 1,
        payload = buildJsonObject {
            put("displayName", "Ada Lovelace")
            put("metadata", buildJsonObject { put("tier", "pro"); put("locale", "en") })
            put(
                "deviceProfile",
                buildJsonObject {
                    put("hardwareConcurrency", 8)
                    put("deviceMemory", 8.0)
                    put("mobile", false)
                    put("screenWidth", 1920)
                    put("screenHeight", 1080)
                    put("platform", "kotlin")
                },
            )
            put(
                "capabilities",
                buildJsonObject {
                    put("simulcast", true)
                    put("svc", false)
                    put("codecs", buildJsonArray { add("VP8"); add("H264") })
                },
            )
        },
    )

    val offer: Envelope = Envelope(
        v = 1,
        type = MessageType.OFFER,
        roomId = "room-42",
        senderId = "user-ada",
        sessionId = "sess-abc-0001",
        ts = 1_786_000_001_000L,
        seq = 2,
        payload = buildJsonObject {
            put(
                "sdp",
                "v=0\r\no=- 4611731406677955671 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
                    "a=group:BUNDLE 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n" +
                    "a=rtpmap:111 opus/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendrecv\r\n" +
                    "a=rtpmap:96 VP8/90000",
            )
            put("label", "main")
        },
    )

    val ice: Envelope = Envelope(
        v = 1,
        type = MessageType.ICE,
        roomId = "room-42",
        senderId = "user-ada",
        sessionId = "sess-abc-0001",
        ts = 1_786_000_001_500L,
        seq = 3,
        payload = buildJsonObject {
            put(
                "candidate",
                "candidate:842163049 1 udp 1677729535 192.168.1.10 53520 typ srflx raddr 0.0.0.0 rport 0 generation 0",
            )
            put("sdpMid", "0")
            put("sdpMLineIndex", 0)
        },
    )

    val all: List<Envelope> = listOf(join, offer, ice)
}
