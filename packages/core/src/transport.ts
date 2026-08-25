/**
 * Signaling transport abstraction (D4).
 *
 * `SignalingTransport` is the single seam between the vidcall engine and any
 * backend (Supabase, Convex, Firebase, Appwrite, Postgres, SQLite, custom).
 * Backends stay dumb: they carry JSON envelopes over their own pub/sub and
 * expose backend-native presence. All ordering/idempotency/glare logic lives
 * in the engine (see `PeerConnectionManager` and `OrderedMessageBuffer`).
 *
 * The interface mirrors docs/architecture.md D4:
 * `join / leave / emit / onMessage / onPresence / setPresence / dispose`.
 */
import type { Envelope, PresenceState } from '@mbsks/openrtc-protocol';

/** Static info a peer announces when joining a room. */
export interface ParticipantInfo {
  id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

/** Presence observation delivered by `onPresence` (backend-native where available). */
export interface ParticipantPresence {
  participantId: string;
  state: PresenceState;
  metadata?: Record<string, unknown>;
}

export interface SignalingTransport {
  /** Join `roomId`, announcing `self`. Resolves when subscribed to the room channel. */
  join(roomId: string, self: ParticipantInfo): Promise<void>;
  /** Leave the room (backend may also derive this from presence expiry). */
  leave(): Promise<void>;
  /** Broadcast an envelope to the room channel (or unicast if `targetSenderId` set). */
  emit(envelope: Envelope): Promise<void>;
  /** Subscribe to room envelopes. Returns an unsubscribe function. */
  onMessage(callback: (envelope: Envelope) => void): () => void;
  /** Subscribe to presence updates. Returns an unsubscribe function. */
  onPresence(callback: (presence: ParticipantPresence) => void): () => void;
  /** Update this peer's presence (backend-native presence where available). */
  setPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void>;
  /** Release all subscriptions/resources. Idempotent. */
  dispose(): Promise<void>;
}

export interface InMemoryTransportOptions {
  /** Called when a message is received, before delivery — for tests. */
  beforeDeliver?: (envelope: Envelope, to: string) => void;
  /** Deliver envelopes back to the sender too (default false). */
  echo?: boolean;
  /** Simulate a lossy/unordered backend by dropping envelopes (default 0). */
  dropRate?: number;
}

/**
 * In-memory `SignalingTransport` for tests and same-process demos.
 *
 * Semantics match a dumb broadcast pub/sub channel:
 *  - `emit` delivers to every other joined peer (unless `echo`).
 *  - Presence is tracked per participant; `setPresence` notifies others.
 *  - Envelopes are delivered on a microtask (async, like a real backend).
 */
export class InMemoryTransport implements SignalingTransport {
  private static readonly rooms = new Map<string, Set<InMemoryTransport>>();
  private readonly roomIdRef: { current: string | null } = { current: null };
  private readonly messageListeners = new Set<(envelope: Envelope) => void>();
  private readonly presenceListeners = new Set<(presence: ParticipantPresence) => void>();
  private presenceState: PresenceState = 'offline';
  private presenceMetadata: Record<string, unknown> | undefined;
  private self: ParticipantInfo | null = null;
  private disposed = false;
  readonly options: InMemoryTransportOptions;

  constructor(options: InMemoryTransportOptions = {}) {
    this.options = options;
  }

  get roomId(): string | null {
    return this.roomIdRef.current;
  }

  async join(roomId: string, self: ParticipantInfo): Promise<void> {
    if (this.roomIdRef.current)
      throw new Error(`InMemoryTransport: already in room ${this.roomIdRef.current}`);
    if (this.disposed) throw new Error('InMemoryTransport: disposed');
    this.self = self;
    this.roomIdRef.current = roomId;
    let room = InMemoryTransport.rooms.get(roomId);
    if (!room) {
      room = new Set();
      InMemoryTransport.rooms.set(roomId, room);
    }
    room.add(this);
  }

  async leave(): Promise<void> {
    const roomId = this.roomIdRef.current;
    if (roomId) {
      const room = InMemoryTransport.rooms.get(roomId);
      room?.delete(this);
      if (room && room.size === 0) InMemoryTransport.rooms.delete(roomId);
    }
    this.roomIdRef.current = null;
  }

  async emit(envelope: Envelope): Promise<void> {
    if (this.disposed) throw new Error('InMemoryTransport: disposed');
    const roomId = this.roomIdRef.current;
    if (!roomId) return; // not (or no longer) in a room: silent no-op
    const room = InMemoryTransport.rooms.get(roomId);
    if (!room) return;
    if (this.options.dropRate && Math.random() < this.options.dropRate) return;
    const peers = [...room];
    for (const peer of peers) {
      if (peer === this && !this.options.echo) continue;
      if (envelope.targetSenderId && envelope.targetSenderId !== peer.self?.id) continue;
      if (peer.disposed) continue;
      this.options.beforeDeliver?.(envelope, peer.self?.id ?? '?');
      queueMicrotask(() => {
        if (!peer.disposed) {
          for (const cb of [...peer.messageListeners]) cb(envelope);
        }
      });
    }
  }

  onMessage(callback: (envelope: Envelope) => void): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  onPresence(callback: (presence: ParticipantPresence) => void): () => void {
    this.presenceListeners.add(callback);
    return () => this.presenceListeners.delete(callback);
  }

  async setPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.self) throw new Error('InMemoryTransport: join() first');
    this.presenceState = state;
    this.presenceMetadata = metadata;
    const roomId = this.roomIdRef.current;
    if (!roomId) return;
    const room = InMemoryTransport.rooms.get(roomId);
    if (!room) return;
    const presence: ParticipantPresence = {
      participantId: this.self.id,
      state,
      metadata,
    };
    for (const peer of room) {
      if (peer === this) continue;
      if (peer.disposed) continue;
      queueMicrotask(() => {
        for (const cb of [...peer.presenceListeners]) cb(presence);
      });
    }
  }

  /** For tests: current presence of this transport. */
  getPresence(): ParticipantPresence {
    return {
      participantId: this.self?.id ?? '',
      state: this.presenceState,
      metadata: this.presenceMetadata,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.leave();
    this.messageListeners.clear();
    this.presenceListeners.clear();
  }
}
