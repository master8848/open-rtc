/**
 * @vidcall/server — core room/session/recording logic.
 *
 * Pure functions: no framework imports, no WebSocket imports, no database
 * imports. Every function takes a `Store` as its first argument, so the
 * same logic runs on SQLite, Postgres, MySQL, or any custom store — and is
 * hosted by Express, Fastify, Django, Laravel, Rails, or a bare
 * `node:http` server (see `http.ts`, `ws.ts`, `express.ts`, `fastify.ts`).
 *
 * The core owns:
 *  - room lifecycle  (create / join / leave / close / state)
 *  - participant roster (who is in a room)
 *  - signal relay   (persist + compute recipients per protocol envelope)
 *  - recording sessions (metadata only; bytes live in `RecordingStorage`)
 */

import { createEnvelope, isEnvelope, type Envelope } from '@vidcall/protocol';
import { errors } from './errors.js';
import type { Store } from './store.js';
import type {
  JoinResult,
  LeaveResult,
  Participant,
  RecordingSession,
  Room,
  SignalDelivery,
} from './types.js';

/** Input for `joinRoom` — everything except server-assigned timestamps. */
export interface ParticipantInput {
  participantId: string;
  sessionId: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRoomOptions {
  /** Explicit room id; server generates a short id when omitted. */
  roomId?: string;
  maxParticipants?: number;
  metadata?: Record<string, unknown>;
  /** Clock override (tests). */
  now?: number;
  /** Room-id generator override (tests). */
  roomIdFactory?: () => string;
}

export interface JoinRoomOptions {
  /** Clock override (tests). */
  now?: number;
  /** When true, re-joining replaces the existing participant record (idempotent). */
  upsert?: boolean;
}

export interface LeaveRoomOptions {
  /** Clock override (tests). */
  now?: number;
  /**
   * A `leave` envelope to persist + relay to remaining members. The WS
   * relay passes the client's own leave envelope here; REST callers may
   * omit it (no broadcast happens).
   */
  envelope?: Envelope;
}

export interface StartRecordingOptions {
  /** Explicit session id; server generates one when omitted. */
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Clock override (tests). */
  now?: number;
  sessionIdFactory?: () => string;
}

export interface StopRecordingOptions {
  /** Clock override (tests). */
  now?: number;
}

/** Short, URL-safe, collision-resistant id (base36 of 128 random bits). */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  // Node >= 18.18 / modern browsers expose crypto.getRandomValues globally.
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(36).padStart(2, '0');
  return s;
}

function nowMs(now?: number): number {
  return now ?? Date.now();
}

async function requireRoom(store: Store, roomId: string): Promise<Room> {
  const room = await store.getRoom(roomId);
  if (!room) throw errors.roomNotFound(roomId);
  return room;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Create a room. Fails with `room_already_exists` when the id is taken.
 */
export async function createRoom(
  store: Store,
  opts: CreateRoomOptions = {},
): Promise<Room> {
  const roomId = opts.roomId ?? (opts.roomIdFactory ?? randomId)();
  const existing = await store.getRoom(roomId);
  if (existing) throw errors.roomAlreadyExists(roomId);
  const t = nowMs(opts.now);
  const room: Room = {
    roomId,
    createdAt: t,
    updatedAt: t,
    state: 'open',
    ...(opts.maxParticipants !== undefined ? { maxParticipants: opts.maxParticipants } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
  await store.putRoom(room);
  return room;
}

/**
 * Fetch a room. Throws `room_not_found` for unknown ids (use `store.getRoom`
 * directly when you need a null result).
 */
export async function getRoom(store: Store, roomId: string): Promise<Room> {
  return requireRoom(store, roomId);
}

/**
 * Close a room: rejects future joins but keeps existing members signaling.
 * Returns the updated room.
 */
export async function closeRoom(
  store: Store,
  roomId: string,
  opts: { now?: number } = {},
): Promise<Room> {
  const room = await requireRoom(store, roomId);
  const updated: Room = { ...room, state: 'closed', updatedAt: nowMs(opts.now) };
  await store.putRoom(updated);
  return updated;
}

/**
 * Add a participant to a room. Enforces room existence + open state +
 * capacity, then returns the full roster.
 */
export async function joinRoom(
  store: Store,
  roomId: string,
  input: ParticipantInput,
  opts: JoinRoomOptions = {},
): Promise<JoinResult> {
  const room = await requireRoom(store, roomId);
  if (room.state === 'closed') throw errors.roomClosed(roomId);

  const existing = await store.getParticipant(roomId, input.participantId);
  if (existing && !opts.upsert) throw errors.participantAlreadyJoined(roomId, input.participantId);
  if (!existing && room.maxParticipants !== undefined) {
    const members = await store.listParticipants(roomId);
    if (members.length >= room.maxParticipants) throw errors.roomFull(roomId);
  }

  const t = nowMs(opts.now);
  const participant: Participant = {
    roomId,
    participantId: input.participantId,
    sessionId: input.sessionId,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    joinedAt: existing?.joinedAt ?? t,
    lastSeenAt: t,
  };
  await store.putParticipant(participant);
  await store.putRoom({ ...room, updatedAt: t });
  return { room, participant, participants: await store.listParticipants(roomId) };
}

/**
 * Remove a participant from a room. When `opts.envelope` (a `leave`
 * envelope) is supplied it is persisted and `delivery` describes who
 * should receive it (remaining members).
 */
export async function leaveRoom(
  store: Store,
  roomId: string,
  participantId: string,
  opts: LeaveRoomOptions = {},
): Promise<LeaveResult> {
  const room = await requireRoom(store, roomId);
  const existing = await store.getParticipant(roomId, participantId);
  if (!existing) throw errors.participantNotFound(roomId, participantId);

  const t = nowMs(opts.now);
  await store.deleteParticipant(roomId, participantId);
  await store.putRoom({ ...room, updatedAt: t });

  let delivery: SignalDelivery | undefined;
  if (opts.envelope) {
    const stored = await store.putSignal({
      roomId,
      envelope: opts.envelope,
      receivedAt: t,
    });
    delivery = {
      envelope: stored.envelope,
      recipients: await store.listParticipants(roomId),
    };
  }
  return { room, participants: await store.listParticipants(roomId), delivery };
}

// ---------------------------------------------------------------------------
// State + roster
// ---------------------------------------------------------------------------

export interface RoomSnapshot {
  room: Room;
  participants: Participant[];
  /** Signals persisted for this room so far (server-assigned seqs). */
  signalCount: number;
}

/** Snapshot of a room: room record + participant roster. */
export async function getRoomState(store: Store, roomId: string): Promise<RoomSnapshot> {
  const room = await requireRoom(store, roomId);
  const participants = await store.listParticipants(roomId);
  const signals = await store.listSignals(roomId, 0);
  return { room, participants, signalCount: signals.length };
}

/** Participant roster for a room. Throws `room_not_found` for unknown rooms. */
export async function listParticipants(store: Store, roomId: string): Promise<Participant[]> {
  await requireRoom(store, roomId);
  return store.listParticipants(roomId);
}

/** Signal log for a room, `seq > since`, ascending. */
export async function listSignals(
  store: Store,
  roomId: string,
  since = 0,
): Promise<import('./types.js').StoredSignal[]> {
  await requireRoom(store, roomId);
  return store.listSignals(roomId, since);
}

// ---------------------------------------------------------------------------
// Signal relay
// ---------------------------------------------------------------------------

/**
 * Relay one protocol envelope: validates it, persists it to the room's
 * signal log, and computes the recipient set.
 *
 * Recipient rules (mirror the client engine's expectations):
 *  - `join` / `leave` / `presence`  → everyone (sender included)
 *  - envelope with `targetSenderId` → that member only
 *  - anything else (`offer`/`answer`/`ice`/`reaction`/`chat`/...) →
 *    room members except the sender
 *
 * Throws `invalid_envelope` for malformed envelopes, `room_not_found` for
 * unknown rooms, and `participant_not_found` when a non-`join` envelope
 * arrives from a sender that is not in the room.
 */
export async function handleSignal(store: Store, envelope: unknown): Promise<SignalDelivery> {
  if (!isEnvelope(envelope)) {
    throw errors.invalidEnvelope('Envelope failed protocol validation (see protocol/schema.json)');
  }
  const room = await requireRoom(store, envelope.roomId);
  const t = Date.now();

  if (envelope.type !== 'join') {
    const participant = await store.getParticipant(envelope.roomId, envelope.senderId);
    if (!participant) {
      throw errors.participantNotFound(envelope.roomId, envelope.senderId);
    }
    if (envelope.type !== 'leave' && room.state === 'closed') {
      throw errors.roomClosed(envelope.roomId);
    }
    // Touch lastSeen so presence/roster stay fresh for heartbeats + signals.
    if (envelope.type !== 'leave') {
      await store.putParticipant({ ...participant, lastSeenAt: t });
    }
  }

  const stored = await store.putSignal({ roomId: envelope.roomId, envelope, receivedAt: t });
  const members = await store.listParticipants(envelope.roomId);

  let recipients: Participant[];
  if (envelope.type === 'join' || envelope.type === 'leave' || envelope.type === 'presence') {
    recipients = members;
  } else if (envelope.targetSenderId) {
    const target = members.find((m) => m.participantId === envelope.targetSenderId);
    recipients = target ? [target] : [];
  } else {
    recipients = members.filter((m) => m.participantId !== envelope.senderId);
  }

  return { envelope: stored.envelope, recipients };
}

// ---------------------------------------------------------------------------
// Recording sessions (metadata only; bytes go to RecordingStorage)
// ---------------------------------------------------------------------------

/**
 * Start a recording session for a room. Only metadata is stored here; the
 * media chunks are handed to a `RecordingStorage` by the hosting layer.
 */
export async function startRecording(
  store: Store,
  roomId: string,
  opts: StartRecordingOptions = {},
): Promise<RecordingSession> {
  await requireRoom(store, roomId);
  const sessionId = opts.sessionId ?? (opts.sessionIdFactory ?? randomId)();
  const recording: RecordingSession = {
    sessionId,
    roomId,
    startedAt: nowMs(opts.now),
    status: 'recording',
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
  await store.putRecording(recording);
  return recording;
}

/**
 * Stop a recording session and mark it `finalized`. Throws
 * `recording_not_found` for unknown sessions.
 */
export async function stopRecording(
  store: Store,
  sessionId: string,
  opts: StopRecordingOptions = {},
): Promise<RecordingSession> {
  const current = await getRecording(store, sessionId);
  const stopped: RecordingSession = {
    ...current,
    stoppedAt: nowMs(opts.now),
    status: 'finalized',
  };
  await store.putRecording(stopped);
  return stopped;
}

/** Fetch one recording session (throws `recording_not_found`). */
export async function getRecording(store: Store, sessionId: string): Promise<RecordingSession> {
  const recording = await store.getRecording(sessionId);
  if (!recording) throw errors.recordingNotFound(sessionId);
  return recording;
}

/** All recording sessions for a room, newest first. */
export async function getRecordings(store: Store, roomId: string): Promise<RecordingSession[]> {
  await requireRoom(store, roomId);
  const all = await store.listRecordings(roomId);
  return [...all].sort((a, b) => b.startedAt - a.startedAt);
}

/** Build the protocol `join` envelope for a participant (relay helper). */
export function buildJoinEnvelope(
  roomId: string,
  participant: ParticipantInput,
): Envelope {
  return createEnvelope('join', {
    roomId,
    senderId: participant.participantId,
    sessionId: participant.sessionId,
    payload: {
      ...(participant.displayName !== undefined ? { displayName: participant.displayName } : {}),
      ...(participant.metadata !== undefined ? { metadata: participant.metadata } : {}),
    },
  });
}

/** Build the protocol `leave` envelope for a participant (relay helper). */
export function buildLeaveEnvelope(
  roomId: string,
  participant: Participant,
  reason?: string,
): Envelope {
  return createEnvelope('leave', {
    roomId,
    senderId: participant.participantId,
    sessionId: participant.sessionId,
    ...(reason !== undefined ? { payload: { reason } } : {}),
  });
}
