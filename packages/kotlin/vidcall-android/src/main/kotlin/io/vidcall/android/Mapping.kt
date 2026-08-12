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
 * Deterministic glare polarity for the mesh, per protocol/schema.json:
 * `polite = selfId < remoteId` (lexicographic string comparison of
 * `senderId`). Both clients derive the same polarity from the two known
 * senderIds. The polite peer rolls back its in-flight offer and accepts the
 * remote offer; the impolite peer ignores a colliding remote offer. The
 * impolite side (larger `senderId`) is the designated first offerer.
 *
 * This MUST match every other binding (TS core: `polite = selfId < remoteId`;
 * Swift: `PerfectNegotiation.isPolite`; Dart: `isPolitePeer`).
 */
fun isPolite(myClientId: String, theirClientId: String): Boolean =
    myClientId < theirClientId
