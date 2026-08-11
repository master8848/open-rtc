package io.vidcall.client

import io.vidcall.protocol.Envelope

/** Lifecycle state of a [SignalingTransport]. */
enum class TransportState {
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    FAILED,
}

/** Callbacks a transport drives; all methods are optional no-ops. */
interface TransportListener {
    /** A raw envelope arrived from the backend. */
    fun onMessage(envelope: Envelope) {}
    fun onState(state: TransportState) {}
    fun onFailure(error: Throwable) {}
}

/**
 * Backend-agnostic signaling transport. Implementations carry the raw
 * schema.json envelope (the wire contract) over any backend: WebSocket,
 * a REST relay, Supabase/Convex/Firebase pub/sub, ...
 *
 * Targeting: [send]'s `targetSessionId` is a *transport-level routing hint* for
 * unicast (peer-to-peer offer/answer/ice); it is **not** part of the envelope.
 * The JS engine mirrors this (its `SignalingBackend.send(msg)` is "unicast or
 * broadcast per msg.target", see docs/research/webrtc-js.md). `null` broadcasts
 * to the whole room channel.
 */
interface SignalingTransport {

    /** Start receiving; [listener] receives messages and state changes. */
    fun connect(listener: TransportListener)

    /** Send an envelope. Throws if the transport is not connected. */
    fun send(envelope: Envelope, targetSessionId: String? = null)

    /** Close the transport and release resources. */
    fun close()
}
