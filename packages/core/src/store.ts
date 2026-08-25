/**
 * Room snapshot layer — a small subscribable store over `Room` state
 * (docs/reviews/perspective-tanstack.md §1, roadmap #1).
 *
 * The engine's ~20 emitter events stay the imperative surface for media
 * events; this module adds the derived, immutable view UI frameworks bind to:
 *
 * ```ts
 * const room = new Room({ roomId, selfId, transport });
 * const unsubscribe = room.subscribe(() => {
 *   console.log(room.getSnapshot().participants.length, 'peers');
 * });
 * ```
 *
 * TanStack-store principles: snapshots are plain frozen-shape objects rebuilt
 * on mutation, referentially stable while nothing changed (an equality check
 * suppresses redundant notifies), and listeners are isolated — one throwing
 * listener never prevents the others from running.
 */
import type { PresenceState } from '@vidcall/protocol';
import type {
  LocalParticipant,
  RemoteParticipant,
  TrackPublication,
  TrackSource,
} from './participants.ts';

// ------------------------------------------------------------------ shapes

/** Immutable per-publication record inside a room snapshot. */
export interface RoomPublicationSnapshot {
  readonly id: string;
  readonly kind: 'audio' | 'video';
  readonly source: TrackSource;
  readonly muted: boolean;
  /** Live track if published (reference-stable while the track lives). */
  readonly track: MediaStreamTrack | null;
}

/** Immutable per-participant record inside a room snapshot. */
export interface RoomParticipantSnapshot {
  readonly id: string;
  readonly displayName?: string;
  /** Compared by reference: replace the object (not mutate it) to update. */
  readonly metadata?: Record<string, unknown>;
  readonly presence: PresenceState;
  readonly connectionState: RTCPeerConnectionState | 'new';
  readonly publications: readonly RoomPublicationSnapshot[];
}

/** Immutable local-participant record inside a room snapshot. */
export interface RoomLocalSnapshot {
  readonly id: string;
  readonly displayName?: string;
  /** Compared by reference: replace the object (not mutate it) to update. */
  readonly metadata?: Record<string, unknown>;
  readonly publications: readonly RoomPublicationSnapshot[];
}

/** Lifecycle of the room itself, mirrored from `join()`/`leave()`. */
export type RoomStatus = 'new' | 'joining' | 'joined' | 'closed';

/**
 * One immutable point-in-time view of a `Room`. Rebuilt whenever tracked
 * state mutates; `getSnapshot()` returns the same object until something
 * actually changed.
 */
export interface RoomSnapshot {
  readonly roomId: string;
  readonly selfId: string;
  readonly status: RoomStatus;
  readonly participants: readonly RoomParticipantSnapshot[];
  readonly local: RoomLocalSnapshot;
  /** Current adaptive-quality tier id (`undefined` until quality is active). */
  readonly qualityTierId: string | undefined;
}

// ------------------------------------------------------------------- store

/**
 * Minimal subscribable snapshot store (the `Subscribable` half of TanStack
 * Store). Notifies listeners only when the snapshot reference changes; a
 * throwing listener is isolated so every other listener still runs.
 */
export class ObservableStore<T> {
  private current: T;
  private readonly listeners = new Set<() => void>();
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(initial: T, onError?: (error: unknown) => void) {
    this.current = initial;
    this.onError = onError;
  }

  /** The current snapshot (referentially stable until it changes). */
  getSnapshot(): T {
    return this.current;
  }

  /** Register a change listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Swap in the next snapshot and notify listeners. No-op (no notification)
   * when `next` is the same reference as the current snapshot.
   */
  set(next: T): void {
    if (Object.is(next, this.current)) return;
    this.current = next;
    this.notify();
  }

  private notify(): void {
    let failure: { error: unknown } | undefined;
    // Snapshot the set so subscribe/unsubscribe during emit cannot affect
    // this pass, and isolate listener errors so one bad listener cannot
    // starve the rest.
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        failure ??= { error: err };
      }
    }
    if (failure) {
      const error = failure.error;
      if (this.onError) this.onError(error);
      else throw error;
    }
  }
}

// --------------------------------------------------------------- equality

function publicationsEqual(
  a: readonly RoomPublicationSnapshot[],
  b: readonly RoomPublicationSnapshot[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      x.source !== y.source ||
      x.muted !== y.muted ||
      x.track !== y.track
    ) {
      return false;
    }
  }
  return true;
}

function participantsEqual(a: RoomParticipantSnapshot, b: RoomParticipantSnapshot): boolean {
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.metadata === b.metadata &&
    a.presence === b.presence &&
    a.connectionState === b.connectionState &&
    publicationsEqual(a.publications, b.publications)
  );
}

/**
 * Structural equality for two snapshots (shallow over records, element-wise
 * over arrays). Used to keep `getSnapshot()` referentially stable when an
 * event fires without actually changing any tracked value.
 */
export function roomSnapshotsEqual(a: RoomSnapshot, b: RoomSnapshot): boolean {
  return (
    a.roomId === b.roomId &&
    a.selfId === b.selfId &&
    a.status === b.status &&
    a.qualityTierId === b.qualityTierId &&
    a.local.id === b.local.id &&
    a.local.displayName === b.local.displayName &&
    a.local.metadata === b.local.metadata &&
    publicationsEqual(a.local.publications, b.local.publications) &&
    a.participants.length === b.participants.length &&
    a.participants.every((p, i) => participantsEqual(p, b.participants[i]!))
  );
}

// ----------------------------------------------------------------- builder

function publicationSnapshots(
  publications: readonly TrackPublication[],
): RoomPublicationSnapshot[] {
  return publications.map((p) => ({
    id: p.id,
    kind: p.kind,
    source: p.source,
    muted: p.muted,
    track: p.track,
  }));
}

/** Input view of a Room used to build a snapshot (keeps this module decoupled). */
export interface RoomSnapshotInput {
  roomId: string;
  selfId: string;
  status: RoomStatus;
  qualityTierId: string | undefined;
  local: LocalParticipant;
  remotes: readonly RemoteParticipant[];
}

/** Build one immutable `RoomSnapshot` from the room's live state. */
export function buildRoomSnapshot(input: RoomSnapshotInput): RoomSnapshot {
  return {
    roomId: input.roomId,
    selfId: input.selfId,
    status: input.status,
    qualityTierId: input.qualityTierId,
    local: {
      id: input.local.id,
      displayName: input.local.displayName,
      metadata: input.local.metadata,
      publications: publicationSnapshots(input.local.publications),
    },
    participants: input.remotes.map((participant): RoomParticipantSnapshot => ({
      id: participant.id,
      displayName: participant.displayName,
      metadata: participant.metadata,
      presence: participant.presence,
      connectionState: participant.connectionState,
      publications: publicationSnapshots(participant.publications),
    })),
  };
}
