/**
 * Ordering & idempotency helpers (webrtc-js.md §4.2).
 *
 * Backends differ in delivery guarantees (ordered, eventually consistent,
 * or unordered), so the ENGINE must be order-tolerant:
 *  - `OrderedMessageBuffer` dedupes per-sender envelopes using the monotonic
 *    `seq` field (stale/duplicate messages are dropped).
 *  - `SdpIdempotencyGuard` (sdp.ts) ignores retransmitted offers/answers via
 *    the SDP `o=` session-id + session-version.
 *  - ICE candidates are buffered until the matching remote description is
 *    applied (see `PeerConnectionManager`).
 */
import type { Envelope } from '@mbsks/openrtc-protocol';

export interface OrderedMessageBufferOptions {
  /**
   * Largest tolerated backward seq gap. A message more than this many seq
   * behind the last seen one is treated as stale (default 0 = strict).
   */
  maxBackwardGap?: number;
}

/**
 * Dedupes/drops stale envelopes per sender `sessionId` using `seq`.
 *
 * `seq` is monotonic per sender (per join session). The buffer accepts a
 * message only if it is newer than everything previously accepted from the
 * same `sessionId`. A new `sessionId` (fresh join) resets the window.
 */
export class OrderedMessageBuffer {
  private readonly lastSeq = new Map<string, number>();
  private readonly maxBackwardGap: number;

  constructor(options: OrderedMessageBufferOptions = {}) {
    this.maxBackwardGap = options.maxBackwardGap ?? 0;
  }

  /**
   * Returns true if the envelope is new (not duplicate/stale) for its sender
   * session, in which case the caller should process it.
   */
  accept(envelope: Envelope): boolean {
    const key = envelope.sessionId;
    const last = this.lastSeq.get(key);
    if (last === undefined) {
      this.lastSeq.set(key, envelope.seq);
      return true;
    }
    if (envelope.seq <= last) {
      // Allow a tiny backward tolerance for in-flight messages around a reset.
      if (envelope.seq >= last - this.maxBackwardGap) return false;
      return false;
    }
    this.lastSeq.set(key, envelope.seq);
    return true;
  }

  /** Drop the window for one sender session (or all). */
  reset(sessionId?: string): void {
    if (sessionId === undefined) this.lastSeq.clear();
    else this.lastSeq.delete(sessionId);
  }

  lastSeqFor(sessionId: string): number | undefined {
    return this.lastSeq.get(sessionId);
  }
}
