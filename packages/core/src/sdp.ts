/**
 * SDP helpers — the engine only needs the `o=` origin line for idempotency
 * (webrtc-js.md §4.2). SDP is otherwise treated as an opaque string.
 */

export interface SdpOrigin {
  username: string;
  /** RFC 4566 `o=` sess-id — stays constant for the lifetime of a peer connection. */
  sessionId: string;
  /** RFC 4566 `o=` sess-version — increments on every renegotiation. */
  sessionVersion: number;
  netType: string;
  addrType: string;
  unicastAddress: string;
}

const ORIGIN_RE = /^o=(\S+) (\S+) (\d+) (\w+) (\w+) (\S+)/m;

/** Parse the `o=` origin line of an SDP, or null if missing/malformed. */
export function parseSdpOrigin(sdp: string): SdpOrigin | null {
  const m = ORIGIN_RE.exec(sdp);
  if (!m) return null;
  return {
    username: m[1] ?? '',
    sessionId: m[2] ?? '',
    sessionVersion: Number(m[3]),
    netType: m[4] ?? '',
    addrType: m[5] ?? '',
    unicastAddress: m[6] ?? '',
  };
}

/**
 * Offer/answer idempotency guard (webrtc-js.md §4.2).
 *
 * A peer connection's `o=` session-id is fixed for its lifetime and its
 * session-version increments on each renegotiation. If a remote offer/answer
 * arrives with the same session-id and a session-version <= the last one we
 * applied, it is a retransmission (duplicate delivery or a stale message from
 * an unordered backend) and must be ignored.
 */
export class SdpIdempotencyGuard {
  private last: { sessionId: string; version: number; type: 'offer' | 'answer' } | null = null;

  /** True if this description is a duplicate of one already applied. */
  isDuplicate(type: 'offer' | 'answer', sdp: string): boolean {
    const origin = parseSdpOrigin(sdp);
    if (!origin) return false; // can't verify — don't block on unparseable SDP
    if (!this.last) return false;
    if (this.last.sessionId !== origin.sessionId) return false;
    return origin.sessionVersion <= this.last.version;
  }

  /** Record an applied description. */
  record(type: 'offer' | 'answer', sdp: string): void {
    const origin = parseSdpOrigin(sdp);
    if (!origin) return;
    this.last = { sessionId: origin.sessionId, version: origin.sessionVersion, type };
  }

  reset(): void {
    this.last = null;
  }

  get lastApplied(): { sessionId: string; version: number; type: 'offer' | 'answer' } | null {
    return this.last;
  }
}
