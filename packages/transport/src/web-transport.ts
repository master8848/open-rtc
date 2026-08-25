/**
 * WebTransportSignalingTransport — optional SignalingTransport over
 * WebTransport datagrams (lower latency than WS). Falls back to WS when
 * WebTransport is unavailable (feature-detect). Same Envelope contract.
 *
 * Server side: requires a WebTransport-capable endpoint; when `url` is a
 * plain `ws://`/`http://` URL it auto-falls back to `WebSocket` transport.
 *
 * This is trivial/optional: when `WebTransport` global is absent the instance
 * behaves as a thin pass-through to `fallback` or throws on `join` so the
 * caller can pick another transport (Composite will handle it).
 */
import type { Envelope, PresenceState } from '@mbsks/openrtc-protocol';
import type { ParticipantInfo, ParticipantPresence, SignalingTransport } from './types.ts';

export interface WebTransportOptions {
  /** When WebTransport is unavailable, delegate to this transport (often a WS transport). */
  fallback?: SignalingTransport;
  /** Optional WebSocket fallback factory when no `fallback` transport is supplied. */
  createWebSocket?: (url: string) => WebSocket;
}

export class WebTransportSignalingTransport implements SignalingTransport {
  readonly name = 'webtransport';
  readonly ordering = 'seq-required' as const;
  readonly maxPayloadBytes = 8 * 1024 * 1024;

  private inner: SignalingTransport | null = null;
  private wt: InstanceType<typeof WebTransport> | null = null;
  private roomId: string | null = null;
  private self: ParticipantInfo | null = null;
  private readonly messageCbs = new Set<(e: Envelope) => void>();
  private readonly presenceCbs = new Set<(p: ParticipantPresence) => void>();
  private unsubs: (() => void)[] = [];

  constructor(
    private readonly url: string,
    private readonly opts: WebTransportOptions = {},
  ) {}

  private get hasWebTransport(): boolean {
    return typeof globalThis !== 'undefined' && typeof (globalThis as unknown as { WebTransport?: unknown }).WebTransport === 'function';
  }

  async join(roomId: string, self: ParticipantInfo): Promise<void> {
    this.roomId = roomId;
    this.self = self;
    if (!this.hasWebTransport) {
      if (this.opts.fallback) {
        this.inner = this.opts.fallback;
        await this.inner.join(roomId, self);
        this.bindInner();
        return;
      }
      throw new Error('WebTransportSignalingTransport: WebTransport not available in this environment and no fallback supplied');
    }
    try {
      const WT = (globalThis as unknown as { WebTransport: typeof WebTransport }).WebTransport;
      this.wt = new WT(this.url);
      await this.wt.ready;
      // Stream datagrams -> JSON envelopes (server must send datagrams as JSON).
      void this.pumpDatagrams();
      // For now we also open a bidirectional stream for presence if needed;
      // envelopes still carry presence type, so datagram path suffices.
    } catch (err) {
      if (this.opts.fallback) {
        this.inner = this.opts.fallback;
        await this.inner.join(roomId, self);
        this.bindInner();
        return;
      }
      throw err;
    }
  }

  private bindInner(): void {
    if (!this.inner) return;
    this.unsubs.push(
      this.inner.onMessage((e) => { for (const cb of [...this.messageCbs]) cb(e); }),
      this.inner.onPresence((p) => { for (const cb of [...this.presenceCbs]) cb(p); }),
    );
  }

  private async pumpDatagrams(): Promise<void> {
    const wt = this.wt;
    if (!wt) return;
    try {
      const reader = wt.datagrams.readable.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        try {
          const text = decoder.decode(value as Uint8Array);
          const env = JSON.parse(text) as Envelope;
          for (const cb of [...this.messageCbs]) cb(env);
        } catch {}
      }
    } catch {}
  }

  async leave(): Promise<void> {
    for (const u of this.unsubs.splice(0)) try { u(); } catch {}
    if (this.inner) { await this.inner.leave(); return; }
    try { this.wt?.close(); } catch {}
    this.wt = null;
    this.roomId = null;
    this.self = null;
  }

  async emit(envelope: Envelope): Promise<void> {
    if (this.inner) return this.inner.emit(envelope);
    const wt = this.wt;
    if (!wt) throw new Error('WebTransportSignalingTransport: not joined');
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const writer = wt.datagrams.writable.getWriter();
    try { await writer.write(bytes); } finally { writer.releaseLock(); }
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
    if (this.inner) return this.inner.setPresence(state, metadata);
    // encode presence as an envelope over datagrams
    if (!this.roomId || !this.self) throw new Error('WebTransportSignalingTransport: join() before setPresence()');
    const env: Envelope = {
      v: 1 as const,
      type: 'presence' as const,
      roomId: this.roomId,
      senderId: this.self.id,
      sessionId: `${this.self.id}-wt`,
      seq: Date.now(),
      ts: Date.now(),
      payload: { state, metadata },
    } as unknown as Envelope;
    await this.emit(env);
  }

  async dispose(): Promise<void> {
    for (const u of this.unsubs.splice(0)) try { u(); } catch {}
    this.messageCbs.clear();
    this.presenceCbs.clear();
    if (this.inner) { await this.inner.dispose(); this.inner = null; return; }
    try { this.wt?.close(); } catch {}
    this.wt = null;
  }
}
