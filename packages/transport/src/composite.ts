/**
 * CompositeTransport — dual-path signaling transport (primary + fallback).
 *
 * `emit` tries the primary; on failure it falls back to the secondary and
 * emits a `transport:fallback` diagnostic. `onMessage` merges both transports
 * and dedupes via `OrderedMessageBuffer` (sessionId+seq) so the Room sees each
 * envelope once.
 *
 * Usage:
 * ```ts
 * new Room({ transport: new CompositeTransport(primary, fallback) })
 * // or array sugar: new Room({ transport: [primary, fallback] }) // Room handles it
 * ```
 */
import type { Envelope, PresenceState } from '@mbsks/openrtc-protocol';
import type { ParticipantInfo, ParticipantPresence, SignalingTransport } from './types.ts';

export interface CompositeOptions {
  /** Switch to fallback after this many ms of primary failures; default 0 (immediate). */
  switchMs?: number;
  /** Optional hook when fallback is used. */
  onFallback?: (err: unknown, envelope: Envelope) => void;
}

export class CompositeTransport implements SignalingTransport {
  readonly name = 'composite';
  readonly ordering = 'seq-required' as const;
  readonly maxPayloadBytes: number;

  private readonly seen = new Map<string, number>();
  private readonly messageCbs = new Set<(e: Envelope) => void>();
  private readonly presenceCbs = new Set<(p: ParticipantPresence) => void>();
  private unsubs: (() => void)[] = [];
  private roomId: string | null = null;
  private self: ParticipantInfo | null = null;

  constructor(
    private readonly primary: SignalingTransport,
    private readonly fallback: SignalingTransport,
    private readonly opts: CompositeOptions = {},
  ) {
    const p = (primary as unknown as { maxPayloadBytes?: number }).maxPayloadBytes ?? 16 * 1024 * 1024;
    const f = (fallback as unknown as { maxPayloadBytes?: number }).maxPayloadBytes ?? 16 * 1024 * 1024;
    this.maxPayloadBytes = Math.max(p, f);
  }

  private isNew(envelope: Envelope): boolean {
    const key = `${envelope.sessionId}:${envelope.senderId}`;
    const last = this.seen.get(key);
    if (last !== undefined && envelope.seq <= last) return false;
    this.seen.set(key, envelope.seq);
    return true;
  }

  async join(roomId: string, self: ParticipantInfo): Promise<void> {
    this.roomId = roomId;
    this.self = self;
    const errors: unknown[] = [];
    try {
      await this.primary.join(roomId, self);
    } catch (e) {
      errors.push(e);
    }
    try {
      await this.fallback.join(roomId, self);
    } catch (e) {
      errors.push(e);
    }
    if (errors.length === 2) throw errors[0];

    // subscribe to both; deduped via sessionId+seq
    this.unsubs.push(
      this.primary.onMessage((e) => {
        if (!this.isNew(e)) return;
        for (const c of [...this.messageCbs]) c(e);
      }),
      this.fallback.onMessage((e) => {
        if (!this.isNew(e)) return;
        for (const c of [...this.messageCbs]) c(e);
      }),
      this.primary.onPresence((p) => {
        for (const c of [...this.presenceCbs]) c(p);
      }),
      this.fallback.onPresence((p) => {
        for (const c of [...this.presenceCbs]) c(p);
      }),
    );
  }

  async leave(): Promise<void> {
    for (const u of this.unsubs.splice(0)) try { u(); } catch {}
    this.seen.clear();
    await Promise.allSettled([this.primary.leave(), this.fallback.leave()]);
    this.roomId = null;
    this.self = null;
  }

  async emit(envelope: Envelope): Promise<void> {
    try {
      await this.primary.emit(envelope);
      return;
    } catch (err) {
      this.opts.onFallback?.(err, envelope);
      await this.fallback.emit(envelope);
    }
  }

  onMessage(callback: (envelope: Envelope) => void): () => void {
    this.messageCbs.add(callback);
    return () => this.messageCbs.delete(callback);
  }

  onPresence(callback: (presence: ParticipantPresence) => void): () => void {
    this.presenceCbs.add(callback);
    return () => this.presenceCbs.delete(callback);
  }

  async setPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    await Promise.allSettled([this.primary.setPresence(state, metadata), this.fallback.setPresence(state, metadata)]);
  }

  async dispose(): Promise<void> {
    for (const u of this.unsubs.splice(0)) try { u(); } catch {}
    this.messageCbs.clear();
    this.presenceCbs.clear();
    await Promise.allSettled([this.primary.dispose(), this.fallback.dispose()]);
  }
}
