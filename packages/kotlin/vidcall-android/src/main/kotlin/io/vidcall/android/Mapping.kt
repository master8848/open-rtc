package io.vidcall.android

import io.vidcall.protocol.AnswerPayload
import io.vidcall.protocol.IcePayload
import io.vidcall.protocol.OfferPayload
import org.webrtc.IceCandidate
import org.webrtc.SessionDescription

/**
 * Pure mappings between org.webrtc value objects and the vidcall wire payloads.
 * Kept as pure functions so they are unit-testable on the JVM without an
 * Android runtime (SDP/ICE are opaque strings on the wire, RFC 3264/8445).
 */

/** org.webrtc offer SDP -> wire `OfferPayload`. */
fun SessionDescription.toOfferPayload(label: String? = null): OfferPayload =
    OfferPayload(sdp = description, label = label)

/** org.webrtc answer SDP -> wire `AnswerPayload`. */
fun SessionDescription.toAnswerPayload(label: String? = null): AnswerPayload =
    AnswerPayload(sdp = description, label = label)

/** org.webrtc trickled ICE candidate -> wire `IcePayload`. */
fun IceCandidate.toIcePayload(): IcePayload =
    IcePayload(candidate = sdp, sdpMid = sdpMid, sdpMLineIndex = sdpMLineIndex)

/**
 * Deterministic glare policy for the mesh: the client with the lexicographically
 * smaller `senderId` initiates the offer (is "impolite"); the other side is
 * "polite" and only answers. Both clients derive the same polarity from the two
 * known senderIds, so exactly one side ever creates the initial offer.
 */
fun shouldInitiate(myClientId: String, theirClientId: String): Boolean =
    myClientId < theirClientId
