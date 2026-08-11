package io.vidcall.client

import io.vidcall.protocol.Envelope

/** In-memory transport for offline tests: captures sends, can inject receives. */
class FakeTransport : SignalingTransport {

    val sent = mutableListOf<Pair<Envelope, String?>>()
    var listener: TransportListener? = null
    var closed = false

    override fun connect(listener: TransportListener) {
        this.listener = listener
        listener.onState(TransportState.CONNECTED)
    }

    override fun send(envelope: Envelope, targetSessionId: String?) {
        sent.add(envelope to targetSessionId)
    }

    override fun close() {
        closed = true
    }

    /** Simulate an incoming envelope from the backend. */
    fun receive(envelope: Envelope) {
        listener?.onMessage(envelope)
    }
}
