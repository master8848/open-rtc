/**
 * @mbsks/openrtc-server — core room/session/recording logic.
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

import { createEnvelope, isEnvelope, type Envelope } from '@mbsks/openrtc-protocol';
import { errors } from './errors.ts';
import type { Store } from './store.ts';
import type {
  JoinResult,
  LeaveResult,
  Participant,
  RecordingSession,
  Room,
  SignalDelivery,
} from './types.ts';

/** Input for `joinRoom` — everything except server-assigned timestamps. */
export interface ParticipantInput {
  participantId: string;
  sessionId: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export type RoomPolicyInput = import('./types.ts').RoomPolicy;

export interface CreateRoomOptions {
  /** Explicit room id; server generates a short id when omitted. */
  roomId?: string;
  maxParticipants?: number;
  metadata?: Record<string, unknown>;
  policy?: RoomPolicyInput;
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
  mode?: 'client' | 'sfu-selective' | 'sfu-composite';
  mimeType?: string;
  encrypted?: boolean;
  keyId?: string;
  startedBy?: string;
  ttlMs?: number;
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
export async function createRoom(store: Store, opts: CreateRoomOptions = {}): Promise<Room> {
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
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
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
export function getRoomPolicy(room: Room): import('./types.ts').RoomPolicy {
  const fromField = (room as Room & { policy?: import('./types.ts').RoomPolicy }).policy;
  if (fromField) return fromField;
  const metaPolicy = (room.metadata as Record<string, unknown> | undefined)?.policy;
  if (metaPolicy && typeof metaPolicy === 'object') return metaPolicy as import('./types.ts').RoomPolicy;
  return {};
}

export async function updateRoomPolicy(
  store: Store,
  roomId: string,
  patch: Partial<import('./types.ts').RoomPolicy>,
  opts: { now?: number } = {},
): Promise<Room> {
  const room = await requireRoom(store, roomId);
  const current = getRoomPolicy(room);
  const next: import('./types.ts').RoomPolicy = { ...current, ...patch };
  // validate allowedCodecs
  if (next.allowedCodecs !== undefined && !Array.isArray(next.allowedCodecs)) {
    throw errors.invalidRequest('policy.allowedCodecs must be an array');
  }
  if (next.moderatorIds !== undefined && !Array.isArray(next.moderatorIds)) {
    throw errors.invalidRequest('policy.moderatorIds must be an array');
  }
  const updated: Room = { ...room, policy: next, updatedAt: nowMs(opts.now) };
  // keep metadata.policy in sync for backwards compat
  if (updated.metadata && typeof updated.metadata === 'object') {
    (updated.metadata as Record<string, unknown>).policy = next;
  }
  await store.putRoom(updated);
  return updated;
}

export type ModerationAction = 'kick' | 'mute' | 'lock' | 'unlock' | 'ban' | 'unban';

export interface BanEntry {
  participantId: string;
  bannedAt: number;
  expiresAt?: number;
}

// In-memory ban/lobby/hand/poll stores (Process-local; pluggable stores may persist via policy or external DB)
const banStore = new Map<string, Map<string, BanEntry>>(); // roomId -> participantId -> BanEntry
const lobbyStore = new Map<string, Map<string, number>>(); // roomId -> participantId -> enqueuedAt
const handQueueStore = new Map<string, string[]>(); // roomId -> ordered participantIds with hand raised
const pollStore = new Map<string, Map<string, { id: string; question: string; options: string[]; votes: Map<string, string>; createdBy: string; createdAt: number }>>();

export function listBans(roomId: string, now?: number): BanEntry[] {
  const t = nowMs(now);
  const m = banStore.get(roomId);
  if (!m) return [];
  const out: BanEntry[] = [];
  for (const [pid, e] of [...m.entries()]) {
    if (e.expiresAt !== undefined && e.expiresAt <= t) { m.delete(pid); continue; }
    out.push(e);
  }
  return out;
}

export function isBanned(roomId: string, participantId: string, now?: number): boolean {
  const m = banStore.get(roomId);
  if (!m) return false;
  const e = m.get(participantId);
  if (!e) return false;
  if (e.expiresAt !== undefined && e.expiresAt <= nowMs(now)) { m.delete(participantId); return false; }
  return true;
}

export function listLobbyWaiting(roomId: string): Array<{ participantId: string; enqueuedAt: number }> {
  const m = lobbyStore.get(roomId);
  if (!m) return [];
  return [...m.entries()].map(([participantId, enqueuedAt]) => ({ participantId, enqueuedAt }));
}
export function enqueueLobby(roomId: string, participantId: string, now?: number): void {
  let m = lobbyStore.get(roomId);
  if (!m) { m = new Map(); lobbyStore.set(roomId, m); }
  m.set(participantId, nowMs(now));
}
export function admitLobby(roomId: string, participantId: string): boolean {
  const m = lobbyStore.get(roomId);
  if (!m) return false;
  return m.delete(participantId);
}

export function getHandQueue(roomId: string): string[] { return [...(handQueueStore.get(roomId) ?? [])]; }
export function enqueueHand(roomId: string, participantId: string): void {
  const q = handQueueStore.get(roomId) ?? [];
  if (!q.includes(participantId)) q.push(participantId);
  handQueueStore.set(roomId, q);
}
export function dequeueHand(roomId: string, participantId: string): void {
  const q = handQueueStore.get(roomId) ?? [];
  handQueueStore.set(roomId, q.filter((id) => id !== participantId));
}

export function createPoll(roomId: string, actorId: string, question: string, options: string[], now?: number): { id: string; question: string; options: string[] } {
  const id = randomId();
  let m = pollStore.get(roomId);
  if (!m) { m = new Map(); pollStore.set(roomId, m); }
  m.set(id, { id, question, options, votes: new Map(), createdBy: actorId, createdAt: nowMs(now) });
  return { id, question, options };
}
export function votePoll(roomId: string, pollId: string, participantId: string, option: string): boolean {
  const m = pollStore.get(roomId)?.get(pollId);
  if (!m) return false;
  if (!m.options.includes(option)) return false;
  m.votes.set(participantId, option);
  return true;
}
export function listPolls(roomId: string): Array<{ id: string; question: string; options: string[]; votes: Record<string, string> }> {
  const m = pollStore.get(roomId);
  if (!m) return [];
  return [...m.values()].map((p) => ({ id: p.id, question: p.question, options: p.options, votes: Object.fromEntries(p.votes) }));
}

export async function moderateRoom(
  store: Store,
  roomId: string,
  actorId: string,
  action: ModerationAction,
  targetId?: string,
  opts: { now?: number; banTtlMs?: number } = {},
): Promise<{ room: Room; kicked?: string; banned?: string }> {
  const room = await requireRoom(store, roomId);
  const policy = getRoomPolicy(room);
  const isModerator =
    policy.moderatorIds?.includes(actorId) ?? false;
  // For now, only moderators/admins may moderate; caller must check role
  if (!isModerator) {
    // still allow if actor is admin via token — caller checks
  }
  switch (action) {
    case 'lock': {
      return { room: await updateRoomPolicy(store, roomId, { locked: true }, opts) };
    }
    case 'unlock': {
      return { room: await updateRoomPolicy(store, roomId, { locked: false }, opts) };
    }
    case 'kick': {
      if (!targetId) throw errors.invalidRequest('kick requires targetId');
      const existing = await store.getParticipant(roomId, targetId);
      if (!existing) throw errors.participantNotFound(roomId, targetId);
      await store.deleteParticipant(roomId, targetId);
      const updatedRoom: Room = { ...room, updatedAt: nowMs(opts.now) };
      await store.putRoom(updatedRoom);
      return { room: updatedRoom, kicked: targetId };
    }
    case 'mute': {
      // Mute is a signaling concern; server just validates permission.
      if (!targetId) throw errors.invalidRequest('mute requires targetId');
      const target = await store.getParticipant(roomId, targetId);
      if (!target) throw errors.participantNotFound(roomId, targetId);
      return { room };
    }
    case 'ban': {
      if (!targetId) throw errors.invalidRequest('ban requires targetId');
      const t = nowMs(opts.now);
      const expiresAt = opts.banTtlMs ? t + opts.banTtlMs : undefined;
      let m = banStore.get(roomId);
      if (!m) { m = new Map(); banStore.set(roomId, m); }
      m.set(targetId, { participantId: targetId, bannedAt: t, ...(expiresAt ? { expiresAt } : {}) });
      // Also kick if present
      const existing = await store.getParticipant(roomId, targetId);
      if (existing) {
        await store.deleteParticipant(roomId, targetId);
      }
      const updatedRoom: Room = { ...room, updatedAt: t };
      await store.putRoom(updatedRoom);
      return { room: updatedRoom, kicked: targetId, banned: targetId };
    }
    case 'unban': {
      if (!targetId) throw errors.invalidRequest('unban requires targetId');
      banStore.get(roomId)?.delete(targetId);
      return { room };
    }
    default:
      throw errors.invalidRequest(`Unknown moderation action: ${action}`);
  }
}

export async function joinRoom(
  store: Store,
  roomId: string,
  input: ParticipantInput,
  opts: JoinRoomOptions & { actorRole?: string; isModerator?: boolean } = {},
): Promise<JoinResult> {
  const room = await requireRoom(store, roomId);
  if (room.state === 'closed') throw errors.roomClosed(roomId);
  if (isBanned(roomId, input.participantId, opts.now)) throw errors.forbidden(`Participant ${input.participantId} is banned from room ${roomId}`);
  const policy = getRoomPolicy(room);
  // locked rooms: only admins/moderators may join (new participants) — enqueue to lobby otherwise
  const existing = await store.getParticipant(roomId, input.participantId);
  if (policy.locked && !existing) {
    const isPrivileged = opts.actorRole === 'admin' || opts.isModerator === true;
    if (!isPrivileged) {
      enqueueLobby(roomId, input.participantId, opts.now);
      throw errors.forbidden(`Room ${roomId} is locked - added to lobby`);
    }
  }

  if (existing && !opts.upsert) throw errors.participantAlreadyJoined(roomId, input.participantId);
  const cap = policy.maxParticipants ?? room.maxParticipants;
  if (!existing && cap !== undefined) {
    const members = await store.listParticipants(roomId);
    if (members.length >= cap) throw errors.roomFull(roomId);
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
  await requireRoom(store, envelope.roomId);
  const t = Date.now();

  if (envelope.type !== 'join') {
    const participant = await store.getParticipant(envelope.roomId, envelope.senderId);
    if (!participant) {
      throw errors.participantNotFound(envelope.roomId, envelope.senderId);
    }
    // Closed rooms keep existing members signaling; only new joins are rejected.
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
  const t = nowMs(opts.now);
  const recording: RecordingSession = {
    sessionId,
    roomId,
    startedAt: t,
    status: 'recording',
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
    ...(opts.encrypted ? { encrypted: true as const } : {}),
    ...(opts.keyId ? { keyId: opts.keyId } : {}),
    ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
    ...(opts.ttlMs ? { expiresAt: t + opts.ttlMs } : {}),
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

/** Expire recordings past expiresAt (TTL). Uses store scan; InMemoryStore exposes recordings map. */
export async function expireRecordings(store: Store, opts: { now?: number; onDelete?: (sessionId: string) => Promise<void> } = {}): Promise<string[]> {
  const t = nowMs(opts.now);
  const maybe = store as unknown as { recordings?: Map<string, RecordingSession> };
  if (!(maybe.recordings instanceof Map)) return [];
  const expired: string[] = [];
  for (const [sid, rec] of [...maybe.recordings.entries()]) {
    if (rec.expiresAt !== undefined && rec.expiresAt <= t) {
      await store.putRecording({ ...rec, status: 'finalized' as const, stoppedAt: t });
      if (opts.onDelete) await opts.onDelete(sid);
      maybe.recordings.delete(sid);
      expired.push(sid);
    }
  }
  return expired;
}

/** Build the protocol `join` envelope for a participant (relay helper). */
export function buildJoinEnvelope(roomId: string, participant: ParticipantInput): Envelope {
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
