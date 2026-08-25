/**
 * InMemoryBackend — an in-process SignalingTransport test double.
 *
 * Semantics mirror `@mbsks/openrtc-core`'s `InMemoryTransport` (and real dumb
 * broadcast pub/sub backends):
 *  - one room per instance; `emit` delivers envelopes to every other joined
 *    peer in the same room (unless `echo`);
 *  - presence events are pushed per peer on `setPresence` / `leave`;
 *  - envelope delivery is asynchronous (microtask), like a real backend.
 *
 * Used by the SHARED adapter test suite as the reference implementation and
 * by unit tests/examples as the "no backend" dev default.
 */
import type { Envelope, PresenceState } from '@mbsks/openrtc-protocol';
import { isEnvelope } from '@mbsks/openrtc-protocol';
import type { ParticipantInfo, ParticipantPresence, SignalingTransport } from './types.js';

export interface InMemoryBackendOptions {
  /** Deliver envelopes back to the sender too (default false). */
  echo?: boolean;
  /** Callback before delivery — for tests. */
  beforeDeliver?: (envelope: Envelope, to: string) => void;
}

export class InMemoryBackend implements SignalingTransport {
  readonly name = 'memory';
  readonly ordering = 'guaranteed' as const;
  readonly maxPayloadBytes = 16 * 1024 * 1024;

  private static readonly rooms = new Map<string, Set<InMemoryBackend>>();
  private readonly echo: boolean;
  private readonly beforeDeliver?: (envelope: Envelope, to: string) => void;
  private roomId: string | null = null;
  private self: ParticipantInfo | null = null;
  private readonly messageCbs = new Set<(envelope: Envelope) => void>();
  private readonly presenceCbs = new Set<(presence: ParticipantPresence) => void>();
  private disposed = false;

  constructor(opts: InMemoryBackendOptions = {}) {
    this.echo = opts.echo ?? false;
    this.beforeDeliver = opts.beforeDeliver;
  }

  get room(): string | null {
    return this.roomId;
  }

  async join(roomId: string, self: ParticipantInfo): Promise<void> {
    if (this.disposed) throw new Error('InMemoryBackend: disposed');
    if (this.roomId !== null)
      throw new Error(`InMemoryBackend: already in room ${this.roomId}; leave() first`);
    this.self = self;
    this.roomId = roomId;
    let room = InMemoryBackend.rooms.get(roomId);
    if (!room) {
      room = new Set();
      InMemoryBackend.rooms.set(roomId, room);
    }
    room.add(this);
  }

  async leave(): Promise<void> {
    const roomId = this.roomId;
    if (roomId) {
      const room = InMemoryBackend.rooms.get(roomId);
      room?.delete(this);
      if (room && room.size === 0) InMemoryBackend.rooms.delete(roomId);
      // presence: peers see this peer go offline
      const selfId = this.self?.id;
      if (selfId) {
        for (const peer of room ?? []) {
          if (peer === this || peer.disposed) continue;
          queueMicrotask(() => {
            for (const cb of [...peer.presenceCbs]) {
              cb({ participantId: selfId, state: 'offline' });
            }
          });
        }
      }
    }
    this.roomId = null;
    this.self = null;
  }

  async emit(envelope: Envelope): Promise<void> {
    if (this.disposed) throw new Error('InMemoryBackend: disposed');
    const roomId = this.roomId;
    if (!roomId) throw new Error('InMemoryBackend: not in a room');
    if (envelope.roomId !== roomId) {
      throw new Error(
        `InMemoryBackend: envelope.roomId ${envelope.roomId} != joined room ${roomId}`,
      );
    }
    const room = InMemoryBackend.rooms.get(roomId);
    if (!room) return;
    const peers = [...room];
    for (const peer of peers) {
      if (peer === this && !this.echo) continue;
      if (envelope.targetSenderId && envelope.targetSenderId !== peer.self?.id) continue;
      if (peer.disposed) continue;
      this.beforeDeliver?.(envelope, peer.self?.id ?? '?');
      queueMicrotask(() => {
        if (!peer.disposed) {
          for (const cb of [...peer.messageCbs]) cb(envelope);
        }
      });
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
    if (this.disposed) throw new Error('InMemoryBackend: disposed');
    if (!this.self) throw new Error('InMemoryBackend: join() first');
    const roomId = this.roomId;
    if (!roomId) return;
    const room = InMemoryBackend.rooms.get(roomId);
    if (!room) return;
    const presence: ParticipantPresence = { participantId: this.self.id, state, metadata };
    for (const peer of room) {
      if (peer === this) continue;
      if (peer.disposed) continue;
      queueMicrotask(() => {
        for (const cb of [...peer.presenceCbs]) cb(presence);
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.leave();
    this.messageCbs.clear();
    this.presenceCbs.clear();
  }
}

/** Type guard helper for tests. */
export function isEnvelopeLike(value: unknown): value is Envelope {
  return isEnvelope(value);
}
