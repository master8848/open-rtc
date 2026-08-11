/**
 * Small helpers for envelope plumbing: per-sender sequencer, session ids,
 * byte measurement. The envelope itself (`Envelope`, `createEnvelope`,
 * `isEnvelope`) lives in `@vidcall/protocol`.
 */

/** Bytes of a UTF-8 string. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Per-sender monotonic sequencer. The ENGINE owns `seq` (protocol rule:
 * "monotonic per sender; engine dedupes/reorders") — this helper exists for
 * apps/backends that want a cheap counter for their own bookkeeping.
 */
export class Sequencer {
  private n = -1;
  next(): number {
    this.n += 1;
    return this.n;
  }
  get value(): number {
    return this.n;
  }
}

/** Generate a random session id (uuid when available). */
export function randomSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
