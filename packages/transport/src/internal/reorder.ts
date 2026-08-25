/**
 * ReorderBuffer — per-sender `seq` buffer over protocol Envelopes.
 *
 * Backends that don't guarantee cross-publisher ordering ('seq-required',
 * e.g. Supabase broadcast and Appwrite doc-events) can deliver SDP
 * offer/answer frames out of order. This buffer holds out-of-order frames per
 * sender and releases them in monotonic `seq` order. ICE candidates tolerate
 * reorder natively and pass straight through.
 *
 * The engine ALSO owns ordering/idempotency/glare (packages/core); adapters
 * enable this buffer by default as a defensive measure — an in-order stream
 * passes through untouched, so it is harmless when the engine reorders too.
 *
 * Anchoring: streams are expected to start at seq 0. If the first observed
 * seq is small (<= maxGap) we wait for the missing prefix (pure reordering);
 * if it is large, earlier frames were almost certainly lost before we began
 * listening, so we anchor there. Frames below the anchor are duplicates.
 * If the gap to the next expected seq exceeds `maxGap` (lost frames), the
 * buffered run is flushed anyway so the call can proceed.
 */
import type { Envelope } from '@mbsks/protocol';

export type KindFilter = (kind: string) => boolean;

export interface ReorderBufferOptions {
  /** Kinds that must be delivered in order; everything else passes through. */
  orderedKinds?: KindFilter | Iterable<string>;
  /** Flush a run if the gap to the next expected seq exceeds this (default 64). */
  maxGap?: number;
  /** Sender state is dropped after this long without activity, ms (default 2_000). */
  timeoutMs?: number;
}

interface SenderState {
  /** next seq expected (anchor = first observed seq). */
  next: number;
  buffer: Map<number, Envelope>;
  lastActivity: number;
}

/** Default kinds that must arrive in order. */
export const DEFAULT_ORDERED_KINDS = new Set(['offer', 'answer', 'sfu']);

export class ReorderBuffer {
  private senders = new Map<string, SenderState>();
  private readonly ordered: KindFilter;
  private readonly maxGap: number;
  private readonly timeoutMs: number;

  constructor(opts: ReorderBufferOptions = {}) {
    const kinds = opts.orderedKinds ?? DEFAULT_ORDERED_KINDS;
    this.ordered = typeof kinds === 'function' ? kinds : (kind) => (kinds as Set<string>).has(kind);
    this.maxGap = opts.maxGap ?? 64;
    this.timeoutMs = opts.timeoutMs ?? 2_000;
  }

  /** Push an inbound envelope; returns envelopes ready for delivery. */
  push(envelope: Envelope): Envelope[] {
    if (!this.ordered(envelope.type)) return [envelope];
    const seq = envelope.seq;
    let s = this.senders.get(envelope.senderId);
    if (!s) {
      const anchor = seq <= this.maxGap ? 0 : seq;
      s = { next: anchor, buffer: new Map(), lastActivity: Date.now() };
      this.senders.set(envelope.senderId, s);
    }
    s.lastActivity = Date.now();
    if (seq < s.next) return []; // duplicate
    if (s.buffer.has(seq)) return [];
    s.buffer.set(seq, envelope);

    const out: Envelope[] = [];
    while (s.buffer.has(s.next)) {
      const m = s.buffer.get(s.next)!;
      s.buffer.delete(s.next);
      s.next += 1;
      out.push(m);
    }
    const largest = s.buffer.size > 0 ? Math.max(...s.buffer.keys()) : s.next - 1;
    if (largest - s.next + 1 > this.maxGap) {
      const sorted = [...s.buffer.keys()].sort((a, b) => a - b);
      for (const k of sorted) out.push(s.buffer.get(k)!);
      s.buffer.clear();
      s.next = largest + 1;
      s.lastActivity = Date.now();
    }
    return out;
  }

  /** Drop sender state idle for longer than timeoutMs. Call on an interval. */
  sweep(now = Date.now()): void {
    for (const [senderId, s] of this.senders) {
      if (now - s.lastActivity > this.timeoutMs) this.senders.delete(senderId);
    }
  }

  /** Forget all buffered state (e.g. on dispose). */
  reset(): void {
    this.senders.clear();
  }

  /** Number of buffered (not yet released) frames. */
  get bufferedCount(): number {
    let n = 0;
    for (const s of this.senders.values()) n += s.buffer.size;
    return n;
  }

  /** Number of tracked senders. */
  get senderCount(): number {
    return this.senders.size;
  }
}
