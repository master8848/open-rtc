/**
 * BaseSignalingTransport — shared plumbing for every backend adapter.
 *
 * Implements the parts of `SignalingTransport` that are backend-agnostic:
 *  - room binding (one room per instance, join/leave lifecycle)
 *  - inbound pipeline: chunk reassembly -> JSON parse -> envelope validation
 *    -> optional per-sender reorder -> onMessage fan-out
 *  - outbound pipeline: chunking above `maxPayloadBytes` (Postgres 7 KB)
 *  - presence heartbeat + stale sweep for backends with no native disconnect
 *  - ICE coalescing for rate-limited backends
 *  - dispose idempotency
 *
 * Subclasses implement the `do*` hooks against their SDK.
 */
import type { Envelope, PresenceState } from '@vidcall/protocol';
import { isEnvelope } from '@vidcall/protocol';
import type { ParticipantInfo, ParticipantPresence, SignalingTransport } from './types.js';
import { ChunkAssembler, encodeChunks, isChunkFrame } from './internal/chunker.js';
import { ReorderBuffer } from './internal/reorder.js';
import { Heartbeat, PresenceSweeper } from './internal/heartbeat.js';
import { IceCoalescer } from './internal/iceCoalescer.js';
import { utf8Bytes } from './wire.js';

export interface BaseOptions {
  /** enable per-sender reorder buffer on inbound (default true). */
  reorder?: boolean;
  /** kinds that must be reordered (default offer/answer/sfu). */
  reorderKinds?: Iterable<string> | ((kind: string) => boolean);
  /** chunk payloads above maxPayloadBytes into frames of this size (default: maxPayloadBytes - 1024, floored at 7000). */
  chunkMaxBytes?: number;
  /** presence heartbeat interval ms (0 disables). Default 5000. */
  heartbeatMs?: number;
  /** presence stale timeout ms (0 disables sweeper). Default 30_000. */
  presenceTimeoutMs?: number;
  /** ICE coalescing window ms (0 disables). Default 0 (off). */
  coalesceIceMs?: number;
}

/**
 * Subclasses implement these hooks. All hooks are called only while the
 * transport is joined; implementations must be idempotent w.r.t. dispose.
 */
export interface BackendHooks {
  /** Subscribe to the room channel + bring up backend-native presence. */
  doJoin(roomId: string, self: ParticipantInfo): Promise<void>;
  /** Unsubscribe from the room channel + drop presence. */
  doLeave(): Promise<void>;
  /** Ship one frame (an Envelope or a ChunkFrame) to the room. */
  doSendFrame(frame: unknown): Promise<void>;
  /** Persist/publish presence (called on setPresence + every heartbeat). */
  doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void>;
  /** Release backend resources. Idempotent. */
  doDispose(): Promise<void>;
}

export abstract class BaseSignalingTransport implements SignalingTransport {
  abstract readonly name: string;
  abstract readonly ordering: 'guaranteed' | 'seq-required';
  abstract readonly maxPayloadBytes: number;

  protected currentRoom: string | null = null;
  protected self: ParticipantInfo | null = null;
  protected lastPresence: { state: PresenceState; metadata?: Record<string, unknown> } | null = null;
  protected disposed = false;

  private readonly messageCbs = new Set<(envelope: Envelope) => void>();
  private readonly presenceCbs = new Set<(presence: ParticipantPresence) => void>();
  private readonly assembler: ChunkAssembler;
  private readonly reorder: ReorderBuffer;
  private readonly presenceTimeoutMs: number;
  private heartbeat: Heartbeat | null = null;
  private sweeper: PresenceSweeper | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private coalescer: IceCoalescer | null = null;

  constructor(private readonly hooks: BackendHooks, private readonly opts: BaseOptions = {}) {
    this.reorder = new ReorderBuffer({
      orderedKinds: opts.reorderKinds,
      ...(opts.reorder === false ? { orderedKinds: () => false } : {}),
    });
    this.presenceTimeoutMs = opts.presenceTimeoutMs ?? 30_000;
    this.assembler = new ChunkAssembler();

    if ((opts.heartbeatMs ?? 5000) > 0) {
      this.heartbeat = new Heartbeat({
        intervalMs: opts.heartbeatMs ?? 5000,
        onBeat: () => {
          const p = this.lastPresence;
          if (p && this.currentRoom !== null) return this.hooks.doSetPresence(p.state, p.metadata);
        },
      });
    }
    if ((opts.presenceTimeoutMs ?? 30_000) > 0) {
      this.sweeper = new PresenceSweeper({
        timeoutMs: opts.presenceTimeoutMs ?? 30_000,
        onStale: (id) => this.deliverPresence({ participantId: id, state: 'offline' }),
      });
    }
    if ((opts.coalesceIceMs ?? 0) > 0) {
      this.coalescer = new IceCoalescer({
        windowMs: opts.coalesceIceMs ?? 100,
        onFlush: async (items) => {
          for (const e of items) await this.hooks.doSendFrame(e);
        },
      });
    }
  }

  // ---------------------------------------------------------------- join/leave
  async join(roomId: string, self: ParticipantInfo): Promise<void> {
    if (this.disposed) throw new Error(`${this.name}: transport disposed`);
    if (this.currentRoom !== null) {
      throw new Error(`${this.name}: already in room ${this.currentRoom}; leave() first`);
    }
    // set state BEFORE the hook so hooks can read currentRoom/self
    this.currentRoom = roomId;
    this.self = self;
    try {
      await this.hooks.doJoin(roomId, self);
    } catch (err) {
      this.currentRoom = null;
      this.self = null;
      throw err;
    }
    this.heartbeat?.start();
    if (this.sweeper) {
      this.sweepTimer = setInterval(() => {
        this.sweeper!.sweep();
        this.reorder.sweep();
      }, Math.max(500, Math.min(this.presenceTimeoutMs, 5000)));
      this.sweepTimer.unref?.();
    }
  }

  async leave(): Promise<void> {
    const room = this.currentRoom;
    if (room === null) return;
    await this.hooks.doLeave();
    this.currentRoom = null;
    this.self = null;
    this.lastPresence = null;
    this.heartbeat?.stop();
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sweeper?.removeAll();
  }

  // ------------------------------------------------------------------- emit
  async emit(envelope: Envelope): Promise<void> {
    if (this.disposed) throw new Error(`${this.name}: transport disposed`);
    if (this.currentRoom === null) throw new Error(`${this.name}: join() before emit()`);
    if (envelope.roomId !== this.currentRoom) {
      throw new Error(`${this.name}: envelope.roomId ${envelope.roomId} != joined room ${this.currentRoom}`);
    }
    if (this.coalescer && envelope.type === 'ice') {
      this.coalescer.push(envelope);
      return;
    }
    await this.sendFrame(envelope);
  }

  /** Chunk size when payloads exceed maxPayloadBytes (null disables chunking). */
  private get chunkMaxBytes(): number | null {
    const raw = this.opts.chunkMaxBytes ?? Math.max(7000, this.maxPayloadBytes - 1024);
    return raw > 0 && raw < this.maxPayloadBytes ? raw : null;
  }

  private async sendFrame(frame: unknown): Promise<void> {
    if (this.chunkMaxBytes === null) {
      await this.hooks.doSendFrame(frame);
      return;
    }
    const json = JSON.stringify(frame);
    if (utf8Bytes(json) > this.maxPayloadBytes) {
      for (const part of encodeChunks(json, this.chunkMaxBytes)) {
        await this.hooks.doSendFrame(part);
      }
    } else {
      await this.hooks.doSendFrame(frame);
    }
  }

  // ------------------------------------------------------------- subscriptions
  onMessage(callback: (envelope: Envelope) => void): () => void {
    this.messageCbs.add(callback);
    return () => this.messageCbs.delete(callback);
  }

  onPresence(callback: (presence: ParticipantPresence) => void): () => void {
    this.presenceCbs.add(callback);
    return () => this.presenceCbs.delete(callback);
  }

  // ----------------------------------------------------------------- presence
  async setPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    if (this.disposed) throw new Error(`${this.name}: transport disposed`);
    if (this.currentRoom === null) throw new Error(`${this.name}: join() before setPresence()`);
    this.lastPresence = { state, metadata };
    await this.hooks.doSetPresence(state, metadata);
  }

  // ------------------------------------------------------------------ dispose
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.heartbeat?.stop();
    this.coalescer?.dispose();
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.hooks.doDispose();
    this.currentRoom = null;
    this.messageCbs.clear();
    this.presenceCbs.clear();
    this.reorder.reset();
  }

  // ------------------------------------------------------------- inbound path
  /**
   * Subclasses call this with every decoded backend frame (an Envelope or a
   * ChunkFrame object). Runs chunk reassembly -> validation -> reorder ->
   * onMessage fan-out.
   */
  protected deliverFrame(frame: unknown): void {
    if (this.disposed) return;
    let envelope: Envelope | undefined;
    if (isChunkFrame(frame)) {
      const json = this.assembler.push(frame);
      if (json === undefined) return; // waiting for more parts
      try {
        const parsed: unknown = JSON.parse(json);
        if (isEnvelope(parsed)) envelope = parsed;
      } catch {
        return; // malformed chunk payload — drop
      }
    } else if (isEnvelope(frame)) {
      envelope = frame;
    } else {
      return;
    }
    if (envelope === undefined) return;
    // ignore echoes of our own frames (broadcast/mirror backends deliver
    // the sender's own writes back through the same channel)
    if (this.self !== null && envelope.senderId === this.self.id) return;
    for (const e of this.reorder.push(envelope)) {
      for (const cb of [...this.messageCbs]) cb(e);
    }
  }

  /** Subclasses call this to emit a presence event to local subscribers. */
  protected deliverPresence(presence: ParticipantPresence): void {
    if (this.disposed) return;
    for (const cb of [...this.presenceCbs]) cb(presence);
  }

  /** Track a peer as recently-seen for the stale sweeper. */
  protected touchPresence(participantId: string): void {
    this.sweeper?.touch(participantId);
  }

  /** Current joined room (null when not joined). */
  get room(): string | null {
    return this.currentRoom;
  }
}
