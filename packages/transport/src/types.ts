/**
 * vidcall signaling transport — shared types.
 *
 * The canonical `SignalingTransport` interface lives in
 * `packages/core/src/transport.ts` (owned by the core agent). This package
 * declares a STRUCTURAL TWIN with the exact same members so that:
 *   - backend adapter packages can depend on the light `@vidcall/transport`
 *     package instead of the engine (`@vidcall/core`) — no engine coupling;
 *   - TypeScript's structural typing means any class implementing the twin
 *     below is assignable to `@vidcall/core`'s `SignalingTransport`, and vice
 *     versa.
 *
 * Wire payloads use `Envelope` from `@vidcall/protocol`
 * (protocol/schema.json mirror) — the single shared wire contract.
 */
import type { Envelope, PresenceState } from '@vidcall/protocol';

/** Static info a peer announces when joining a room (twin of core's). */
export interface ParticipantInfo {
  id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

/** Presence observation delivered by `onPresence` (twin of core's). */
export interface ParticipantPresence {
  participantId: string;
  state: PresenceState;
  metadata?: Record<string, unknown>;
}

/**
 * The unified signaling transport contract implemented by every backend
 * adapter (Supabase, Convex, Postgres, SQLite, Appwrite, Firebase, ...).
 * Identical shape to `packages/core/src/transport.ts` `SignalingTransport`.
 *
 * Semantics (from core):
 *  - a transport instance is bound to ONE room at a time (`join`/`leave`);
 *  - `emit` broadcasts an `Envelope` to the room (backend pub/sub);
 *  - backends stay dumb: they carry JSON envelopes and expose backend-native
 *    presence; ordering/idempotency/glare live in the engine;
 *  - `onPresence` delivers per-peer `ParticipantPresence` events.
 */
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

/** Extra metadata every adapter exposes (not part of the core interface). */
export interface TransportMetadata {
  /** Adapter name: 'supabase' | 'convex' | 'postgres' | 'sqlite' | 'appwrite' | 'firebase' | 'memory' | ... */
  readonly name: string;
  /**
   * Ordering guarantee of the underlying backend:
   *  - 'guaranteed': backend preserves per-sender order
   *  - 'seq-required': cross-publisher order is not guaranteed
   */
  readonly ordering: 'guaranteed' | 'seq-required';
  /** Adapter payload cap in bytes; adapters chunk above this. */
  readonly maxPayloadBytes: number;
}

/**
 * Legacy room-arg-based interface from docs/research/backend-adapters.md §10.
 * Superseded by `SignalingTransport` above (per packages/core) — kept for
 * compatibility with apps that prefer explicit room arguments and message
 * shapes decoupled from the wire envelope.
 */
export interface SignalingMessage {
  kind: string;
  payload: unknown;
  from: string;
  seq?: number;
  ts: number;
}

export interface PresenceUser {
  id: string;
  data: Record<string, unknown>;
  lastSeen: number;
}

export interface JoinedRoom {
  room: string;
  users: PresenceUser[];
}

export type Unsubscribe = () => void;

/** Room-arg-based variant (research §10). */
export interface SignalingBackend {
  readonly name: string;
  readonly ordering: 'guaranteed' | 'seq-required';
  readonly maxPayloadBytes: number;
  join(room: string, opts?: { self?: PresenceUser }): Promise<JoinedRoom>;
  leave(room: string): Promise<void>;
  emit(room: string, msg: SignalingMessage): Promise<void>;
  onMessage(room: string, cb: (msg: SignalingMessage) => void): Unsubscribe;
  onPresence(room: string, cb: (users: PresenceUser[]) => void): Unsubscribe;
  setPresence(room: string, data: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
}
