/**
 * ReconnectingTransport — wrapper that auto-reconnects with exponential
 * backoff and optional seq replay.
 *
 * On `emit` failure or explicit `reconnect()` call it retries `inner.join`
 * with exponential backoff (`backoffMs * factor^attempt`) up to
 * `maxAttempts`, then replays missed signals via `fetchSignals(roomId, since)`
 * when supplied (e.g. `store.listSignals`). Emits `onStateChange` for UI:
 * `'reconnecting' | 'reconnected' | 'failed'`.
 *
 * Usage:
 * ```ts
 * const t = new ReconnectingTransport(inner, {
 *   maxAttempts: 5, backoffMs: 200,
 *   fetchSignals: (roomId, since) => fetch(`/rooms/${roomId}/signals?since=${since}`).then(r=>r.json()),
 * });
 * new Room({ transport: t, reconnect: { maxAttempts: 5 } }) // or Room does it via config
 * ```
 */
import type { Envelope, PresenceState } from '@mbsks/openrtc-protocol';
import type { ParticipantInfo, ParticipantPresence, SignalingTransport } from './types.ts';

export type ReconnectState = 'reconnecting' | 'reconnected' | 'failed';

export interface ReconnectingOptions {
  /** Max re-join attempts; default 5. 0 = no retry. */
  maxAttempts?: number;
  /** Base backoff in ms; default 300. */
  backoffMs?: number;
  /** Exponential factor; default 2. */
  backoffFactor?: number;
  /** Cap for backoff delay; default 10000. */
  maxBackoffMs?: number;
  /** Optional replay: fetch envelopes with seq > since. */
  fetchSignals?: (roomId: string, sinceSeq: number) => Promise<Envelope[]>;
  /** UI hook. */
  onStateChange?: (state: ReconnectState, attempt: number) => void;
  /** For tests: inject delay (default setTimeout). */
  delayFn?: (ms: number) => Promise<void>;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ReconnectingTransport implements SignalingTransport {
  readonly name: string;
  readonly ordering: 'guaranteed' | 'seq-required';
  readonly maxPayloadBytes: number;

  private roomId: string | null = null;
  private self: ParticipantInfo | null = null;
  private lastSeq = -1;
  private readonly messageCbs = new Set<(e: Envelope) => void>();
  private readonly presenceCbs = new Set<(p: ParticipantPresence) => void>();
  private innerUnsubs: (() => void)[] = [];
  private reconnecting = false;
  private closed = false;

  constructor(
    private readonly inner: SignalingTransport,
    private readonly opts: ReconnectingOptions = {},
  ) {
    this.name = `reconnecting:${(inner as unknown as { name?: string }).name ?? 'inner'}`;
    this.ordering = (inner as unknown as { ordering?: 'guaranteed' | 'seq-required' }).ordering ?? 'seq-required';
    this.maxPayloadBytes = (inner as unknown as { maxPayloadBytes?: number }).maxPayloadBytes ?? 8 * 1024 * 1024;
  }

  async join(roomId: string, self: ParticipantInfo): Promise<void> {
    this.roomId = roomId;
    this.self = self;
    this.closed = false;
    await this.inner.join(roomId, self);
    this.bindInner();
  }

  private bindInner(): void {
    for (const u of this.innerUnsubs.splice(0)) try { u(); } catch {}
    this.innerUnsubs.push(
      this.inner.onMessage((e) => {
        if (typeof e.seq === 'number' && e.seq > this.lastSeq) this.lastSeq = e.seq;
        for (const cb of [...this.messageCbs]) cb(e);
      }),
      this.inner.onPresence((p) => {
        for (const cb of [...this.presenceCbs]) cb(p);
      }),
    );
  }

  async leave(): Promise<void> {
    this.closed = true;
    for (const u of this.innerUnsubs.splice(0)) try { u(); } catch {}
    await this.inner.leave();
    this.roomId = null;
    this.self = null;
  }

  async emit(envelope: Envelope): Promise<void> {
    if (typeof envelope.seq === 'number' && envelope.seq > this.lastSeq) this.lastSeq = envelope.seq;
    try {
      await this.inner.emit(envelope);
      return;
    } catch (err) {
      if (this.closed || !this.roomId || !this.self) throw err;
      await this.doReconnect();
      // one retry after reconnect
      await this.inner.emit(envelope);
    }
  }

  private async doReconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const maxAttempts = this.opts.maxAttempts ?? 5;
    const base = this.opts.backoffMs ?? 300;
    const factor = this.opts.backoffFactor ?? 2;
    const cap = this.opts.maxBackoffMs ?? 10_000;
    const delayFn = this.opts.delayFn ?? defaultDelay;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.opts.onStateChange?.('reconnecting', attempt);
      const delay = Math.min(base * Math.pow(factor, attempt), cap);
      await delayFn(delay);
      try {
        // best-effort leave then re-join
        try { await this.inner.leave(); } catch {}
        await this.inner.join(this.roomId!, this.self!);
        this.bindInner();
        // optional replay
        if (this.opts.fetchSignals) {
          try {
            const missed = await this.opts.fetchSignals(this.roomId!, this.lastSeq);
            for (const env of missed) {
              for (const cb of [...this.messageCbs]) cb(env);
              if (typeof env.seq === 'number' && env.seq > this.lastSeq) this.lastSeq = env.seq;
            }
          } catch {}
        }
        this.opts.onStateChange?.('reconnected', attempt);
        this.reconnecting = false;
        return;
      } catch {}
    }
    this.opts.onStateChange?.('failed', maxAttempts);
    this.reconnecting = false;
    throw new Error('ReconnectingTransport: maxAttempts exceeded');
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
    await this.inner.setPresence(state, metadata);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const u of this.innerUnsubs.splice(0)) try { u(); } catch {}
    this.messageCbs.clear();
    this.presenceCbs.clear();
    await this.inner.dispose();
  }
}
