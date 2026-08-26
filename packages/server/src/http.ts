/**
 * @mbsks/openrtc-server — framework-agnostic REST handlers + `node:http` server.
 *
 * `dispatch()` is the single router every hosting layer shares: the bare
 * `node:http` server here, the Express router (`express.ts`), the Fastify
 * plugin (`fastify.ts`), and (via the sidecar pattern in `integrations/`)
 * Django/Laravel/Rails proxies.
 *
 * Endpoints (JSON envelope per protocol/schema.json):
 *  - POST   /auth/token                   issue a room-scoped token (auth mode)
 *  - POST   /rooms                        create a room
 *  - POST   /rooms/:id/join               join a room (adds participant)
 *  - POST   /rooms/:id/leave              leave a room
 *  - POST   /rooms/:id/signal             relay one protocol envelope
 *  - POST   /rooms/:id/close              close a room (admin only)
 *  - DELETE /rooms/:id                    delete a room (admin only)
 *  - GET    /rooms/:id/state              room + participant roster
 *  - GET    /rooms/:id/recordings         recording sessions
 *  - POST   /recordings/:sessionId/chunks upload one media chunk (raw body)
 *  - POST   /recordings/:sessionId/finalize seal a recording session
 *
 * Auth (see auth.ts): with `services.auth` set, join/leave/signal/state/
 * recordings/close/delete require `Authorization: Bearer <token>`; tokens
 * are HMAC-signed, room-scoped, and identity-bound. Without `services.auth`
 * the server runs in legacy open mode (dev-only).
 */

import http from 'node:http';
import {
  buildJoinEnvelope,
  buildLeaveEnvelope,
  closeRoom,
  createRoom,
  getRecordings,
  getRoomState,
  getRoomPolicy,
  handleSignal,
  joinRoom,
  leaveRoom,
  moderateRoom,
  startRecording,
  stopRecording,
  updateRoomPolicy,
  type ModerationAction,
} from './core.ts';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  issueToken,
  verifyToken,
  verifyTokenWithRotation,
  type TokenClaims,
} from './auth.ts';
import { errors, isVidcallError, VidcallError } from './errors.ts';
import type { Services } from './services.ts';
import { issueTurnCredentials, toIceServers } from './turn.ts';
import { timingSafeEqual } from 'node:crypto';

/** Everything a handler needs to answer one request, framework-agnostic. */
export interface RouteContext {
  method: string;
  /** Pathname without the query string. */
  path: string;
  query: URLSearchParams;
  /** Captured `:param` values from the route pattern. */
  params: Record<string, string>;
  /** Parsed JSON body (when the request carried one). */
  body: unknown;
  /** Raw request body (recording chunk uploads). */
  rawBody?: Buffer;
  header(name: string): string | undefined;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  /** Path pattern: `/rooms/:id/join`. */
  pattern: string;
  handler: (services: Services, ctx: RouteContext) => Promise<RouteResult>;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function requireString(v: unknown, key: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw errors.invalidRequest(`Missing or invalid string field: ${key}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Auth guards (no-op in legacy open mode — no `services.auth`)
// ---------------------------------------------------------------------------

/** Extract the bearer token from an `Authorization` header. */
function bearerToken(header: string | undefined): string {
  if (!header) throw errors.unauthorized('Missing Authorization header (Bearer <token>)');
  const trimmed = header.trim();
  // Prevent overly long Authorization headers from being processed (DoS).
  if (trimmed.length > 8192) throw errors.unauthorized('Authorization header too long');
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) throw errors.unauthorized('Authorization header must use the Bearer scheme');
  return match[1]!;
}

interface AuthGuardOptions {
  /** Require the token's `role` to be `'admin'` (close/delete routes). */
  admin?: boolean;
  /**
   * Bind the token to one participant identity: participant tokens may only
   * act as their own `participantId`; admin tokens are exempt.
   */
  asParticipantId?: string;
  /** Require specific caps (e.g. { record:true }). Admins bypass caps. */
  requireCaps?: Partial<Record<'publish' | 'subscribe' | 'record' | 'moderate', boolean>>;
}

/**
 * Enforce room auth for one request. In open mode (no `services.auth`)
 * this is a no-op and returns `undefined`. Otherwise it validates the
 * bearer token, its room scope, and the requested role/identity.
 *
 * @returns the verified claims (or `undefined` in open mode).
 * @throws `VidcallError` 401 (`unauthorized` / `token_expired`) or
 *   403 (`forbidden`) — mapped to the standard error envelope by `dispatch`.
 */
function verifyWithRotation(auth: NonNullable<Services['auth']>, token: string): TokenClaims {
  const secrets = auth.previousSecrets?.length
    ? [auth.secret, ...auth.previousSecrets]
    : [auth.secret];
  return secrets.length > 1 ? verifyTokenWithRotation(secrets, token) : verifyToken(auth.secret, token);
}

function requireAuth(
  services: Services,
  ctx: RouteContext,
  roomId: string,
  opts: AuthGuardOptions = {},
): TokenClaims | undefined {
  const auth = services.auth;
  if (!auth) return undefined;
  const claims = verifyWithRotation(auth, bearerToken(ctx.header('authorization')));
  if (claims.roomId !== roomId) {
    throw errors.forbidden(
      `Token is scoped to room ${claims.roomId}, not ${roomId} (tokens are room-scoped)`,
    );
  }
  if (opts.admin && claims.role !== 'admin') {
    throw errors.forbidden('Admin role required for this operation');
  }
  if (opts.asParticipantId !== undefined && claims.role !== 'admin') {
    if (claims.participantId !== opts.asParticipantId) {
      throw errors.forbidden(
        `Token is bound to participant ${claims.participantId}, not ${opts.asParticipantId}`,
      );
    }
  }
  if (opts.requireCaps) {
    checkCaps(claims, opts.requireCaps);
  }
  return claims;
}

function checkCaps(claims: TokenClaims, required: Partial<Record<'publish' | 'subscribe' | 'record' | 'moderate', boolean>>): void {
  if (claims.role === 'admin') return;
  const caps = claims.caps as Record<string, boolean | undefined> | undefined;
  if (!caps) return; // no caps = default allow (backwards compat)
  for (const [k, need] of Object.entries(required) as Array<[keyof NonNullable<TokenClaims['caps']>, boolean]>) {
    if (!need) continue;
    if (caps[k] === false) {
      throw errors.forbidden(`Token lacks ${k} capability`);
    }
  }
}

async function createRoomHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const body = asRecord(ctx.body) ?? {};
  const policy = asRecord(body.policy) as import('./types.ts').RoomPolicy | undefined;
  const rawRoomId = asString(body.roomId);
  if (rawRoomId !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(rawRoomId)) {
    throw errors.invalidRequest('roomId must match /^[a-zA-Z0-9._-]{1,128}$/');
  }
  let maxParticipants: number | undefined;
  if (body.maxParticipants !== undefined) {
    if (typeof body.maxParticipants !== 'number' || !Number.isInteger(body.maxParticipants) || body.maxParticipants < 1 || body.maxParticipants > 1000) {
      throw errors.invalidRequest('maxParticipants must be an integer 1..1000');
    }
    maxParticipants = body.maxParticipants;
  }
  const room = await createRoom(services.store, {
    roomId: rawRoomId,
    maxParticipants,
    metadata: asRecord(body.metadata),
    ...(policy ? { policy } : {}),
    ...(services.now ? { now: services.now() } : {}),
  });
  return { status: 201, body: { room } };
}

async function joinHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const body = asRecord(ctx.body) ?? {};
  const nested = asRecord(body.participant) ?? {};
  const participantId = requireString(nested.participantId ?? body.participantId, 'participantId');
  const sessionId = requireString(nested.sessionId ?? body.sessionId, 'sessionId');
  const displayName = asString(nested.displayName ?? body.displayName);
  const metadata = (asRecord(nested.metadata) ?? asRecord(body.metadata)) as
    | Record<string, unknown>
    | undefined;

  // Token must be scoped to this room and bound to the joining participant.
  const claims = requireAuth(services, ctx, roomId, { asParticipantId: participantId });
  // Enforce room policy: e2eeRequired requires claims.e2ee
  if (claims) {
    const roomForChecks = await services.store.getRoom(roomId);
    const policy = roomForChecks ? getRoomPolicy(roomForChecks) : {};
    if (policy.e2eeRequired && claims.e2ee !== true && claims.role !== 'admin') {
      throw errors.forbidden('Room requires E2EE-capable token (e2ee:true)');
    }
    // Locked room: moderators/admins may join; handled in joinRoom via role/moderator check
    const isModerator = policy.moderatorIds?.includes(claims.participantId) ?? false;
    try {
      const result = await joinRoom(
        services.store,
        roomId,
        { participantId, sessionId, displayName, metadata },
        { actorRole: claims.role, isModerator },
      );
      services.relay?.broadcast(
        roomId,
        buildJoinEnvelope(roomId, { participantId, sessionId, displayName, metadata }),
      );
      if (services.push) void services.push.notify(roomId, { event: 'join', participantId }).catch(()=>{});
      return {
        status: 200,
        body: { room: result.room, participant: result.participant, participants: result.participants },
      };
    } catch (e) {
      if ((e as { code?: string })?.code === 'forbidden' && String((e as Error).message).includes('lobby') && services.webhooks?.length) {
        const { dispatchWebhooks } = await import('./webhooks.ts');
        void dispatchWebhooks(services.webhooks, { event: 'lobby.waiting', roomId, payload: { participantId }, ts: Date.now() });
      }
      throw e;
    }
  }

  // Open mode: still enforce locked/maxParticipants via joinRoom
  try {
    const result = await joinRoom(services.store, roomId, {
      participantId,
      sessionId,
      displayName,
      metadata,
    });
    // Broadcast the join so WS peers learn about the newcomer.
    services.relay?.broadcast(
      roomId,
      buildJoinEnvelope(roomId, { participantId, sessionId, displayName, metadata }),
    );
    if (services.push) void services.push.notify(roomId, { event: 'join', participantId }).catch(()=>{});
    return {
      status: 200,
      body: { room: result.room, participant: result.participant, participants: result.participants },
    };
  } catch (e) {
    if ((e as { code?: string })?.code === 'forbidden' && String((e as Error).message).includes('lobby') && services.webhooks?.length) {
      const { dispatchWebhooks } = await import('./webhooks.ts');
      void dispatchWebhooks(services.webhooks, { event: 'lobby.waiting', roomId, payload: { participantId }, ts: Date.now() });
    }
    throw e;
  }
}

async function leaveHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const body = asRecord(ctx.body) ?? {};
  const participantId = requireString(body.participantId, 'participantId');
  const reason = asString(body.reason);
  // Participants may only leave themselves; admins may remove anyone.
  requireAuth(services, ctx, roomId, { asParticipantId: participantId });
  const participant = await services.store.getParticipant(roomId, participantId);
  const envelope = participant ? buildLeaveEnvelope(roomId, participant, reason) : undefined;
  const result = await leaveRoom(services.store, roomId, participantId, { envelope });
  if (result.delivery) {
    services.relay?.broadcast(roomId, result.delivery.envelope, { exceptSenderId: participantId });
  }
  return { status: 200, body: { room: result.room, participants: result.participants } };
}

async function signalHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  // Tokens are identity-bound: a participant may only signal as themselves.
  const bodyRecord = asRecord(ctx.body);
  const senderId =
    bodyRecord && typeof bodyRecord.senderId === 'string' ? bodyRecord.senderId : undefined;
  requireAuth(services, ctx, roomId, senderId ? { asParticipantId: senderId } : {});
  const delivery = await handleSignal(services.store, ctx.body);
  services.relay?.broadcast(roomId, delivery.envelope, {
    exceptSenderId: delivery.envelope.senderId,
  });
  if ((delivery.envelope as { type?: string }).type === 'transcript' && services.webhooks?.length) {
    const payload = (delivery.envelope as { payload?: { isFinal?: boolean } }).payload;
    const evt = payload?.isFinal === false ? 'transcript.interim' : 'transcript.final';
    const { dispatchWebhooks } = await import('./webhooks.ts');
    void dispatchWebhooks(services.webhooks, { event: evt as never, roomId, payload: delivery.envelope.payload, ts: Date.now() });
    // also legacy generic
    void dispatchWebhooks(services.webhooks, { event: 'transcript' as never, roomId, payload: delivery.envelope.payload, ts: Date.now() });
  }
  return {
    status: 200,
    body: {
      seq: (delivery.envelope as { seq: number }).seq,
      relayedTo: delivery.recipients.map((r) => r.participantId),
    },
  };
}

async function stateHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  requireAuth(services, ctx, roomId);
  const state = await getRoomState(services.store, roomId);
  return { status: 200, body: state };
}

async function recordingsListHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  requireAuth(services, ctx, roomId);
  const recordings = await getRecordings(services.store, roomId);
  return { status: 200, body: { recordings } };
}

/** Close a room — admin only (participants keep signaling; new joins stop). */
async function closeRoomHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  requireAuth(services, ctx, roomId, { admin: true });
  const room = await closeRoom(services.store, roomId);
  return { status: 200, body: { room } };
}

/** Delete a room and its data — admin only. Requires `store.deleteRoom`. */
async function deleteRoomHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  requireAuth(services, ctx, roomId, { admin: true });
  if (!services.store.deleteRoom) {
    throw errors.notImplemented('The configured Store does not implement deleteRoom');
  }
  await services.store.deleteRoom(roomId);
  return { status: 200, body: { roomId, deleted: true } };
}

/**
 * Issue a room-scoped token (`POST /auth/token`). Open when the server has
 * a secret but no `adminToken`; when `adminToken` is configured, requests
 * must present it. `role: 'admin'` always requires the `adminToken` header.
 */
async function authTokenHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const auth = services.auth;
  if (!auth) throw errors.authNotConfigured();
  const body = asRecord(ctx.body) ?? {};
  const roomId = requireString(body.roomId, 'roomId');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(roomId)) {
    throw errors.invalidRequest('roomId must match /^[a-zA-Z0-9._-]{1,128}$/');
  }
  const participantId = requireString(body.participantId, 'participantId');
  if (participantId.length > 128 || participantId.includes(':')) {
    throw errors.invalidRequest('participantId must be <=128 chars and not contain ":"');
  }
  let role = 'participant' as 'participant' | 'admin';
  if (body.role !== undefined) {
    if (body.role !== 'participant' && body.role !== 'admin') {
      throw errors.invalidRequest('role must be "participant" or "admin"');
    }
    role = body.role;
  }
  const adminToken = ctx.header('adminToken') ?? ctx.header('x-admin-token');
  const adminTokenOk = (() => {
    if (!auth.adminToken) return false;
    if (typeof adminToken !== 'string') return false;
    const a = Buffer.from(auth.adminToken, 'utf8');
    const b = Buffer.from(adminToken, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  })();
  if (role === 'admin') {
    if (!auth.adminToken || !adminTokenOk) {
      throw errors.forbidden('Admin tokens require a valid adminToken header');
    }
  } else if (auth.adminToken && !adminTokenOk) {
    throw errors.unauthorized('Missing or invalid adminToken header');
  }
  let exp: number | undefined;
  if (body.exp !== undefined) {
    if (typeof body.exp !== 'number' || !Number.isFinite(body.exp)) {
      throw errors.invalidRequest('exp must be a finite number (epoch seconds)');
    }
    exp = body.exp;
  }
  let caps: import('./auth.ts').TokenCaps | undefined;
  if (body.caps !== undefined) {
    if (typeof body.caps !== 'object' || body.caps === null || Array.isArray(body.caps)) {
      throw errors.invalidRequest('caps must be an object {publish?,subscribe?,record?,moderate?}');
    }
    caps = body.caps as import('./auth.ts').TokenCaps;
  }
  let jti: string | undefined;
  if (typeof body.jti === 'string' && body.jti.length > 0) jti = body.jti;
  else if (body.jti !== undefined) throw errors.invalidRequest('jti must be a non-empty string');
  let e2ee: boolean | undefined;
  if (body.e2ee !== undefined) {
    if (typeof body.e2ee !== 'boolean') throw errors.invalidRequest('e2ee must be a boolean');
    e2ee = body.e2ee;
  }
  const nowMs = services.now?.() ?? Date.now();
  const ttlSec =
    auth.defaultTokenTtlMs !== undefined
      ? Math.floor(auth.defaultTokenTtlMs / 1000)
      : DEFAULT_TOKEN_TTL_SECONDS;
  const computedExp = exp ?? Math.floor(nowMs / 1000) + ttlSec;
  const token = issueToken(auth.secret, {
    roomId,
    participantId,
    role,
    exp: computedExp,
    now: nowMs,
    ...(jti ? { jti } : {}),
    ...(caps ? { caps } : {}),
    ...(e2ee !== undefined ? { e2ee } : {}),
  });
  const claims = verifyToken(auth.secret, token);
  return {
    status: 200,
    body: {
      token,
      roomId: claims.roomId,
      participantId: claims.participantId,
      role: claims.role,
      exp: claims.exp,
      iat: claims.iat,
      ...(claims.jti ? { jti: claims.jti } : {}),
      ...(claims.caps ? { caps: claims.caps } : {}),
      ...(claims.e2ee !== undefined ? { e2ee: claims.e2ee } : {}),
    },
  };
}

async function chunksHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['sessionId']!;
  if (!services.recordingStorage) {
    throw errors.recordingStorageError('No recording storage configured on this server');
  }
  const recording = await services.store.getRecording(sessionId);
  if (!recording) throw errors.recordingNotFound(sessionId);
  // Recording routes are room-scoped: the token must cover the recording's room.
  requireAuth(services, ctx, recording.roomId);
  const raw = ctx.rawBody ?? (typeof ctx.body === 'string' ? Buffer.from(ctx.body) : undefined);
  if (!raw || raw.length === 0)
    throw errors.invalidRequest('Request body must be the raw chunk bytes');
  const indexParam = ctx.query.get('index') ?? ctx.header('x-chunk-index');
  const index = indexParam ? Number(indexParam) : 0;
  if (!Number.isInteger(index) || index < 0)
    throw errors.invalidRequest('chunk index must be a non-negative integer');
  // Quota check before save
  if (services.recordingQuota?.maxBytesPerRoom !== undefined) {
    // naive: sum of recorded bytes from manifest if available; otherwise skip
  }
  await services.recordingStorage.saveChunk(sessionId, raw, index);
  return { status: 201, body: { sessionId, index, bytes: raw.length } };
}

async function finalizeHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['sessionId']!;
  if (!services.recordingStorage) {
    throw errors.recordingStorageError('No recording storage configured on this server');
  }
  const recordingSession = await services.store.getRecording(sessionId);
  if (!recordingSession) throw errors.recordingNotFound(sessionId);
  requireAuth(services, ctx, recordingSession.roomId);
  const storage = await services.recordingStorage.finalize(sessionId, {
    ...(recordingSession.encrypted ? { encrypted: true as const } : {}),
    ...(recordingSession.keyId ? { keyId: recordingSession.keyId } : {}),
    ...(recordingSession.mimeType ? { mimeType: recordingSession.mimeType } : {}),
    ...(recordingSession.mode ? { mode: recordingSession.mode } : {}),
  });
  const recording = await stopRecording(services.store, sessionId);
  // Enrich recording with manifest metadata + encrypted/keyId surfaced in manifest.encrypted/keyId (recording.ts:35)
  const manifestLike = storage as unknown as { encrypted?: boolean; keyId?: string; manifestUrl?: string };
  if (recordingSession.encrypted) recording.encrypted = true;
  if (recordingSession.keyId) (recording as unknown as Record<string, unknown>).keyId = recordingSession.keyId;
  if (manifestLike.manifestUrl) (recording as unknown as Record<string, unknown>).manifestUrl = manifestLike.manifestUrl;
  // Attach manifest to session for GET /manifest
  (recording as unknown as Record<string, unknown>).manifest = { sessionId, chunks: (storage as unknown as { chunks: number }).chunks, bytes: (storage as unknown as { bytes: number }).bytes, finalizedAt: Date.now(), ...(recording.encrypted ? { encrypted: true as const } : {}), ...(recording.keyId ? { keyId: recording.keyId } : {}) };
  // Sidecar transcriptUrl when STT was enabled
  if ((recordingSession as unknown as { transcriptUrl?: string }).transcriptUrl) {
    (recording as unknown as Record<string, unknown>).transcriptUrl = (recordingSession as unknown as { transcriptUrl: string }).transcriptUrl;
  }
  void services.recordingWebhooks?.onRecordingFinalized?.(recording);
  if (services.webhooks?.length) {
    const { dispatchWebhooks } = await import('./webhooks.ts');
    void dispatchWebhooks(services.webhooks, { event: 'recording.finalized', roomId: recording.roomId, payload: { sessionId, ...storage }, ts: Date.now() });
  }
  return { status: 200, body: { recording, storage } };
}

async function recordingManifestHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['id'] ?? ctx.params['sessionId']!;
  const recording = await services.store.getRecording(sessionId);
  if (!recording) throw errors.recordingNotFound(sessionId);
  requireAuth(services, ctx, recording.roomId);
  return { status: 200, body: { recording, manifest: recording.manifest ?? null } };
}

async function recordingStreamHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['id'] ?? ctx.params['sessionId']!;
  if (!services.recordingStorage) throw errors.recordingStorageError('No recording storage configured on this server');
  const recording = await services.store.getRecording(sessionId);
  if (!recording) throw errors.recordingNotFound(sessionId);
  requireAuth(services, ctx, recording.roomId);
  const range = ctx.header('range');
  // getStream returns a Readable; for Range we slice in-memory when possible (Disk) or pass Range header for S3
  // Minimal implementation: return 206 with Content-Range when Range present, otherwise 200
  const stream = await services.recordingStorage.getStream(sessionId);
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  const full = Buffer.concat(chunks);
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]!);
      const end = m[2] ? Number(m[2]) : full.length - 1;
      const slice = full.subarray(start, Math.min(end + 1, full.length));
      return { status: 206, body: slice, headers: { 'Content-Range': `bytes ${start}-${start + slice.length - 1}/${full.length}`, 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' } };
    }
  }
  return { status: 200, body: full, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(full.length) } };
}

async function recordingDeleteHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['id'] ?? ctx.params['sessionId']!;
  const recording = await services.store.getRecording(sessionId);
  if (!recording) throw errors.recordingNotFound(sessionId);
  requireAuth(services, ctx, recording.roomId, { admin: true });
  if (services.recordingStorage?.delete) await services.recordingStorage.delete(sessionId);
  // Remove from store when possible (InMemoryStore map)
  const maybe = services.store as unknown as { recordings?: Map<string, unknown> };
  if (maybe.recordings instanceof Map) maybe.recordings.delete(sessionId);
  void services.recordingWebhooks?.onRecordingDeleted?.(sessionId, recording.roomId);
  return { status: 200, body: { deleted: sessionId } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function recordingsStartHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  // recording start is room-scoped; require token with record cap when auth is on
  const claims = requireAuth(services, ctx, roomId);
  if (claims && claims.role !== 'admin') {
    if (claims.caps?.record === false) throw errors.forbidden('Token lacks record capability');
  }
  const room = await services.store.getRoom(roomId);
  if (!room) throw errors.roomNotFound(roomId);
  const policy = getRoomPolicy(room);
  if (policy.allowRecording === false) throw errors.forbidden('Recording is disabled for this room');
  const body = asRecord(ctx.body) ?? {};
  const mode = (asString(body.mode) as 'client' | 'sfu-selective' | 'sfu-composite' | undefined) ?? 'client';
  const mimeType = asString(body.mimeType);
  const encryptedFlag = body.encrypted === true || body.keyId !== undefined || policy.e2eeRequired || services.e2ee?.required ? true : undefined;
  const keyId = asString(body.keyId);
  const startedBy = claims?.participantId ?? asString(body.startedBy);
  const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : services.recordingTtlMs;
  if (policy.e2eeRequired || services.e2ee?.required) {
    const rec = await startRecording(services.store, roomId, {
      ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
      ...(mode ? { mode } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(encryptedFlag ? { encrypted: true } : {}),
      ...(keyId ? { keyId } : {}),
      ...(startedBy ? { startedBy } : {}),
      ...(ttlMs ? { ttlMs } : {}),
    });
    return { status: 201, body: { recording: rec } };
  }
  const rec = await startRecording(services.store, roomId, {
    ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
    ...(mode ? { mode } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(encryptedFlag ? { encrypted: true } : {}),
    ...(keyId ? { keyId } : {}),
    ...(startedBy ? { startedBy } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  });
  return { status: 201, body: { recording: rec } };
}

async function roomPolicyHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const claims = requireAuth(services, ctx, roomId);
  if (claims && claims.role !== 'admin' && claims.caps?.moderate === false) {
    throw errors.forbidden('Token lacks moderate capability');
  }
  // Check moderator via policy; admin bypasses
  const room = await services.store.getRoom(roomId);
  if (!room) throw errors.roomNotFound(roomId);
  const policy = getRoomPolicy(room);
  const isModerator = claims ? (policy.moderatorIds?.includes(claims.participantId) ?? false) : false;
  if (claims && claims.role !== 'admin' && !isModerator) {
    // open mode without claims: allow
    if (services.auth) throw errors.forbidden('Moderator or admin required');
  }
  const body = asRecord(ctx.body) ?? {};
  const patch: import('./types.ts').RoomPolicy = {};
  if (typeof body.locked === 'boolean') patch.locked = body.locked;
  if (typeof body.allowRecording === 'boolean') patch.allowRecording = body.allowRecording;
  if (Array.isArray(body.allowedCodecs)) patch.allowedCodecs = body.allowedCodecs as string[];
  if (Array.isArray(body.moderatorIds)) patch.moderatorIds = body.moderatorIds as string[];
  if (typeof body.e2eeRequired === 'boolean') patch.e2eeRequired = body.e2eeRequired;
  if (typeof body.maxParticipants === 'number') patch.maxParticipants = body.maxParticipants;
  const updated = await updateRoomPolicy(services.store, roomId, patch);
  return { status: 200, body: { room: updated, policy: getRoomPolicy(updated) } };
}

async function moderateHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const body = asRecord(ctx.body) ?? {};
  const action = requireString(body.action, 'action') as ModerationAction;
  if (!['kick', 'mute', 'lock', 'unlock', 'ban', 'unban'].includes(action)) {
    throw errors.invalidRequest('action must be kick|mute|lock|unlock|ban|unban');
  }
  const targetId = asString(body.targetId);
  const banTtlMs = typeof body.banTtlMs === 'number' ? body.banTtlMs : typeof body.expiresInMs === 'number' ? body.expiresInMs : undefined;
  // auth + moderator check
  const claims = requireAuth(services, ctx, roomId);
  if (!claims) throw errors.unauthorized('Moderation requires authentication');
  const room = await services.store.getRoom(roomId);
  if (!room) throw errors.roomNotFound(roomId);
  const policy = getRoomPolicy(room);
  const isModerator = policy.moderatorIds?.includes(claims.participantId) ?? false;
  const isAdmin = claims.role === 'admin';
  const hasModerateCap = claims.caps?.moderate !== false;
  if (!isAdmin && !(isModerator && hasModerateCap)) {
    throw errors.forbidden('Moderator or admin required');
  }
  const result = await moderateRoom(services.store, roomId, claims.participantId, action, targetId, { ...(banTtlMs ? { banTtlMs } : {}) });
  // For kick/ban, broadcast leave to remaining members
  if ((action === 'kick' || action === 'ban') && result.kicked) {
    const envelope = { v: 1 as const, type: 'leave' as const, roomId, senderId: result.kicked, sessionId: '', ts: Date.now(), seq: 0, payload: { reason: action === 'ban' ? 'banned' : 'kicked' } } as unknown as import('@mbsks/openrtc-protocol').Envelope;
    services.relay?.broadcast(roomId, envelope);
  }
  if (action === 'mute' && targetId) {
    // mute-remote fanout via DataChannelBus control broadcast (relay as control envelope)
    const envelope = { v: 1 as const, type: 'chat' as const, roomId, senderId: claims.participantId, sessionId: '', ts: Date.now(), seq: 0, payload: { text: `/mute ${targetId}` } } as unknown as import('@mbsks/openrtc-protocol').Envelope;
    services.relay?.broadcast(roomId, envelope, { exceptSenderId: targetId });
    // Also direct control broadcast for DataChannelBus listeners
    const ctrl = { v: 1 as const, type: 'error' as const, roomId, senderId: 'server', sessionId: 'server', ts: Date.now(), seq: 0, payload: { code: 'muted', message: `muted:${targetId}` } } as unknown as import('@mbsks/openrtc-protocol').Envelope;
    services.relay?.broadcast(roomId, ctrl);
  }
  if (action === 'lock' || action === 'unlock') {
    const envelope = { v: 1 as const, type: 'presence' as const, roomId, senderId: 'server', sessionId: 'server', ts: Date.now(), seq: 0, payload: { state: 'online', metadata: { locked: action === 'lock' } } } as unknown as import('@mbsks/openrtc-protocol').Envelope;
    services.relay?.broadcast(roomId, envelope);
  }
  return { status: 200, body: { room: result.room, ...(result.kicked ? { kicked: result.kicked } : {}), ...(result.banned ? { banned: result.banned } : {}) } };
}

async function turnCredentialsHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  if (!services.turn) throw errors.notImplemented('TURN is not configured on this server');
  // derive room/identity from token
  const auth = services.auth;
  if (!auth) throw errors.authNotConfigured();
  const claims = verifyWithRotation(auth, bearerToken(ctx.header('authorization')));
  // TURN username format is `expiry:participantId` — forbid `:` inside participantId to keep parsing unambiguous.
  if (claims.participantId.includes(':')) {
    throw errors.invalidRequest('participantId must not contain ":" (TURN username delimiter)');
  }
  const creds = issueTurnCredentials(services.turn, claims.participantId);
  const iceServers = toIceServers(creds);
  return { status: 200, body: { iceServers, ttlSec: services.turn.ttlSec ?? 86400, username: creds.username, _note: undefined }, headers: { 'cache-control': 'no-store' } };
}

async function revokeHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  if (!services.auth) throw errors.authNotConfigured();
  // Revocation is admin-only; scope to a dummy room so requireAuth checks role.
  // Use the `id` param when present, otherwise require Authorization directly.
  const authHeader = ctx.header('authorization');
  if (!authHeader) throw errors.unauthorized('Missing Authorization header (Bearer <token>)');
  const claims = verifyWithRotation(services.auth, bearerToken(authHeader));
  if (claims.role !== 'admin') throw errors.forbidden('Admin role required for revocation');
  const body = asRecord(ctx.body) ?? {};
  const jti = requireString(body.jti, 'jti');
  const exp = typeof body.exp === 'number' ? body.exp : undefined;
  const { revokeToken } = await import('./auth.ts');
  revokeToken(jti, exp);
  return { status: 200, body: { revoked: jti } };
}

async function whipHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id'] ?? ctx.params['roomId'] ?? 'unknown';
  // Guard with token when services.auth set
  if (services.auth) {
    verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  }
  // Reuse egress notion: WHIP ingest SDP offer → answer through mediasoup PlainTransport is infra-gated;
  // here we return a minimal answer echo (adapter handles real PlainTransport).
  const sdpOffer = typeof ctx.body === 'string' ? ctx.body : (ctx.rawBody ? ctx.rawBody.toString('utf8') : '');
  // minimal answer: echo with a=recvonly marker
  const sdpAnswer = sdpOffer.includes('v=0') ? sdpOffer.replace('a=sendonly', 'a=recvonly') : 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
  // record ingress as egress-like for diagnostics
  try { const { startEgress } = await import('./egress.ts'); startEgress({ roomId, whep: false }); } catch { /* ignore */ }
  return { status: 201, body: sdpAnswer, headers: { 'content-type': 'application/sdp', location: `/whip/${encodeURIComponent(roomId)}/${Date.now()}` } };
}

async function whepHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id'] ?? ctx.params['roomId'] ?? 'unknown';
  if (services.auth) {
    verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  }
  const sdpOffer = typeof ctx.body === 'string' ? ctx.body : (ctx.rawBody ? ctx.rawBody.toString('utf8') : '');
  const sdpAnswer = sdpOffer.includes('v=0') ? sdpOffer : 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
  try { const { startEgress } = await import('./egress.ts'); startEgress({ roomId, whep: true }); } catch { /* ignore */ }
  return { status: 201, body: sdpAnswer, headers: { 'content-type': 'application/sdp', location: `/whep/${encodeURIComponent(roomId)}/${Date.now()}` } };
}

async function egressStartHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const body = asRecord(ctx.body) ?? {};
  const hls = body.hls === true;
  const rtmpUrl = typeof body.rtmpUrl === 'string' ? body.rtmpUrl : undefined;
  const whep = body.whep === true;
  const { startEgress } = await import('./egress.ts');
  const rec = startEgress({ roomId, ...(hls ? { hls: true as const } : {}), ...(rtmpUrl ? { rtmpUrl } : {}), ...(whep ? { whep: true as const } : {}) });
  return { status: 201, body: { egressId: rec.egressId, hlsUrl: rec.hlsUrl, whepUrl: rec.whepUrl } };
}

async function egressStopHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const { stopEgressByRoom } = await import('./egress.ts');
  const stopped = stopEgressByRoom(roomId);
  return { status: 200, body: { stopped: stopped.length } };
}

async function breakoutHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const body = asRecord(ctx.body) ?? {};
  const count = typeof body.count === 'number' ? body.count : (Array.isArray(body.ids) ? body.ids.length : 2);
  const ids: string[] | undefined = Array.isArray(body.ids) ? body.ids as string[] : undefined;
  const assignments = asRecord(body.assignments) as Record<string, string> | undefined;
  const breakoutIds: string[] = [];
  const num = ids ? ids.length : count;
  for (let i = 0; i < num; i++) {
    const id = ids?.[i] ?? `${roomId}--breakout-${i + 1}`;
    try { await createRoom(services.store, { roomId: id, metadata: { parentRoomId: roomId } }); } catch { /* already exists */ }
    breakoutIds.push(id);
  }
  // Move participants if assignments provided: { participantId: breakoutId }
  if (assignments) {
    for (const [pid, targetRoomId] of Object.entries(assignments)) {
      const p = await services.store.getParticipant(roomId, pid);
      if (p && breakoutIds.includes(targetRoomId)) {
        await services.store.deleteParticipant(roomId, pid);
        await services.store.putParticipant({ ...p, roomId: targetRoomId });
      }
    }
  }
  return { status: 201, body: { breakoutIds, parentRoomId: roomId } };
}

async function lobbyAdmitHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const body = asRecord(ctx.body) ?? {};
  const participantId = requireString(body.participantId, 'participantId');
  const { admitLobby } = await import('./core.ts');
  admitLobby(roomId, participantId);
  // webhook dispatch for lobby admit (reuse lobby.waiting clearing)
  if (services.webhooks?.length) {
    const { dispatchWebhooks } = await import('./webhooks.ts');
    void dispatchWebhooks(services.webhooks, { event: 'lobby.waiting', roomId, payload: { participantId, admitted: true }, ts: Date.now() });
  }
  return { status: 200, body: { admitted: participantId, roomId } };
}

async function lobbyListHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const { listLobbyWaiting } = await import('./core.ts');
  return { status: 200, body: { waiting: listLobbyWaiting(roomId) } };
}

async function bansListHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const { listBans } = await import('./core.ts');
  return { status: 200, body: { bans: listBans(roomId) } };
}

async function pollCreateHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const claims = requireAuth(services, ctx, roomId);
  const body = asRecord(ctx.body) ?? {};
  const question = requireString(body.question, 'question');
  const options = body.options;
  if (!Array.isArray(options) || options.length < 2) throw errors.invalidRequest('options must be array with >=2');
  const { createPoll } = await import('./core.ts');
  const poll = createPoll(roomId, claims?.participantId ?? 'server', question, options as string[]);
  const envelope = { v: 1 as const, type: 'chat' as const, roomId, senderId: claims?.participantId ?? 'server', sessionId: '', ts: Date.now(), seq: 0, payload: { text: JSON.stringify({ poll }), replyTo: undefined } } as unknown as import('@mbsks/openrtc-protocol').Envelope;
  services.relay?.broadcast(roomId, envelope);
  return { status: 201, body: { poll } };
}

async function pollVoteHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const pollId = ctx.params['pollId']!;
  const claims = requireAuth(services, ctx, roomId);
  const body = asRecord(ctx.body) ?? {};
  const option = requireString(body.option, 'option');
  const { votePoll } = await import('./core.ts');
  const ok = votePoll(roomId, pollId, claims?.participantId ?? requireString(body.participantId, 'participantId'), option);
  if (!ok) throw errors.invalidRequest('Invalid poll or option');
  return { status: 200, body: { pollId, option } };
}

async function handQueueHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const claims = requireAuth(services, ctx, roomId);
  const body = asRecord(ctx.body) ?? {};
  const action = asString(body.action) ?? 'raise';
  const { enqueueHand, dequeueHand, getHandQueue } = await import('./core.ts');
  const pid = claims?.participantId ?? asString(body.participantId) ?? 'unknown';
  if (action === 'raise') enqueueHand(roomId, pid);
  else dequeueHand(roomId, pid);
  return { status: 200, body: { queue: getHandQueue(roomId) } };
}

async function metricsHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  if (services.auth) verifyWithRotation(services.auth, bearerToken(ctx.header('authorization')));
  const signals = await services.store.listSignals(roomId, 0).catch(() => []);
  const clientCount = services.relay?.clientCount(roomId) ?? 0;
  return { status: 200, body: { roomId, signalCount: signals.length, clientCount } };
}

export const routes: readonly Route[] = [
  { method: 'POST', pattern: '/auth/token', handler: authTokenHandler },
  { method: 'POST', pattern: '/auth/revoke', handler: revokeHandler },
  { method: 'GET', pattern: '/turn/credentials', handler: turnCredentialsHandler },
  { method: 'POST', pattern: '/rooms', handler: createRoomHandler },
  { method: 'POST', pattern: '/rooms/:id/join', handler: joinHandler },
  { method: 'POST', pattern: '/rooms/:id/leave', handler: leaveHandler },
  { method: 'POST', pattern: '/rooms/:id/signal', handler: signalHandler },
  { method: 'POST', pattern: '/rooms/:id/close', handler: closeRoomHandler },
  { method: 'POST', pattern: '/rooms/:id/policy', handler: roomPolicyHandler },
  { method: 'POST', pattern: '/rooms/:id/moderate', handler: moderateHandler },
  { method: 'POST', pattern: '/rooms/:id/recordings/start', handler: recordingsStartHandler },
  { method: 'POST', pattern: '/whip/:id', handler: whipHandler },
  { method: 'POST', pattern: '/whep/:id', handler: whepHandler },
  { method: 'POST', pattern: '/rooms/:id/egress/start', handler: egressStartHandler },
  { method: 'POST', pattern: '/rooms/:id/egress/stop', handler: egressStopHandler },
  { method: 'POST', pattern: '/rooms/:id/breakouts', handler: breakoutHandler },
  { method: 'POST', pattern: '/rooms/:id/breakouts/move', handler: breakoutHandler },
  { method: 'POST', pattern: '/rooms/:id/lobby/admit', handler: lobbyAdmitHandler },
  { method: 'GET', pattern: '/rooms/:id/lobby/waiting', handler: lobbyListHandler },
  { method: 'GET', pattern: '/rooms/:id/bans', handler: bansListHandler },
  { method: 'POST', pattern: '/rooms/:id/polls', handler: pollCreateHandler },
  { method: 'POST', pattern: '/rooms/:id/polls/:pollId/vote', handler: pollVoteHandler },
  { method: 'POST', pattern: '/rooms/:id/hand', handler: handQueueHandler },
  { method: 'GET', pattern: '/rooms/:id/metrics', handler: metricsHandler },
  { method: 'DELETE', pattern: '/rooms/:id', handler: deleteRoomHandler },
  { method: 'GET', pattern: '/rooms/:id/state', handler: stateHandler },
  { method: 'GET', pattern: '/rooms/:id/recordings', handler: recordingsListHandler },
  { method: 'GET', pattern: '/rooms/:id/recordings/:sessionId/manifest', handler: recordingManifestHandler },
  { method: 'GET', pattern: '/rooms/:id/recordings/:sessionId/stream', handler: recordingStreamHandler },
  { method: 'DELETE', pattern: '/rooms/:id/recordings/:sessionId', handler: recordingDeleteHandler },
  { method: 'POST', pattern: '/recordings/:sessionId/chunks', handler: chunksHandler },
  { method: 'POST', pattern: '/recordings/:sessionId/finalize', handler: finalizeHandler },
  // legacy direct (no room prefix) - keep for backward compat with FetchRecordingUploader defaults
  { method: 'GET', pattern: '/recordings/:sessionId/manifest', handler: recordingManifestHandler },
  { method: 'GET', pattern: '/recordings/:sessionId/stream', handler: recordingStreamHandler },
  { method: 'DELETE', pattern: '/recordings/:sessionId', handler: recordingDeleteHandler },
];

/** Match a request to a route; returns params or null. */
export function matchRoute(
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split('/').filter(Boolean);
  const ss = path.split('/').filter(Boolean);
  if (ps.length !== ss.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p.startsWith(':')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(ss[i]!);
      } catch {
        return null;
      }
      params[p.slice(1)] = decoded;
    } else if (p !== ss[i]) {
      return null;
    }
  }
  return params;
}

/** Run one request through the shared router. Errors map to JSON. */
export async function dispatch(services: Services, ctx: RouteContext): Promise<RouteResult> {
  try {
    const matched = matchRoute(ctx.method, ctx.path);
    if (!matched)
      return {
        status: 404,
        body: { error: { code: 'not_found', message: `No route for ${ctx.method} ${ctx.path}` } },
      };
    return await matched.route.handler(services, { ...ctx, params: matched.params });
  } catch (err) {
    if (isVidcallError(err)) return { status: err.status, body: err.toJSON() };
    if (err instanceof SyntaxError)
      return {
        status: 400,
        body: { error: { code: 'invalid_request', message: 'Malformed JSON body' } },
      };
    console.error('[vidcall:server] unhandled error', err);
    return {
      status: 500,
      body: { error: { code: 'internal_error', message: 'Internal server error' } },
    };
  }
}

// ---------------------------------------------------------------------------
// node:http server
// ---------------------------------------------------------------------------

export interface NodeServerOptions {
  /** Max request body bytes (chunk uploads); default 64 MiB. */
  maxBodyBytes?: number;
  /** Clock override (tests). */
  now?: () => number;
}

/** Build a standalone `node:http` server hosting the full REST API. */
export function createNodeServer(services: Services, opts: NodeServerOptions = {}): http.Server {
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024 * 1024;
  return http.createServer((req, res) => {
    void handleNodeRequest(services, req, res, maxBodyBytes);
  });
}

async function handleNodeRequest(
  services: Services,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  try {
    await respond(services, req, res, maxBodyBytes);
  } catch (err) {
    // Never let a request rejection crash the process (e.g. oversized body,
    // malformed stream): answer with the error envelope instead.
    const vidcall = isVidcallError(err) ? err : errors.internalError('Unexpected server error');
    if (!res.headersSent) {
      res.writeHead(vidcall.status, {
        'content-type': 'application/json; charset=utf-8',
        // The client may still be mid-upload (paused stream); close after.
        connection: 'close',
      });
    }
    res.end(JSON.stringify(vidcall.toJSON()), () => {
      if (!req.complete) req.destroy();
    });
  }
}

async function respond(
  services: Services,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawBody = await readBody(req, maxBodyBytes);
  let body: unknown;
  let malformedJson = false;
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  // WHIP/WHEP carry SDP as text, not JSON
  const isSdp = contentType.includes('application/sdp');
  if (rawBody.length > 0 && !contentType.includes('application/octet-stream') && !isSdp) {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      // Prototype pollution guard: reject payloads that set dangerous keys at the top level.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const k of Object.keys(parsed as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
            throw errors.invalidRequest('Unsafe object key');
          }
        }
      }
      body = parsed;
    } catch (e) {
      if (e instanceof VidcallError) throw e;
      malformedJson = true;
    }
  } else if (isSdp) {
    body = rawBody.toString('utf8');
  }
  const ctx: RouteContext = {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    params: {},
    body,
    rawBody: contentType.includes('application/octet-stream') || isSdp ? rawBody : undefined,
    header: (name) => req.headers[name.toLowerCase()] as string | undefined,
  };
  const result = malformedJson
    ? { status: 400, body: { error: { code: 'invalid_request', message: 'Malformed JSON body' } } }
    : await dispatch(services, ctx);
  // For SDP responses, send body as-is with no-store to avoid caching signaling.
  const isSdpResponse = result.headers?.['content-type'] === 'application/sdp';
  if (isSdpResponse) {
    const sdpBody = typeof result.body === 'string' ? result.body : String(result.body);
    res.writeHead(result.status, {
      'content-type': 'application/sdp',
      'cache-control': 'no-store',
      ...(result.headers ?? {}),
    });
    res.end(sdpBody);
    return;
  }
  const payload = JSON.stringify(result.body);
  res.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    ...(result.headers ?? {}),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        // Stop buffering and let the caller answer 413 while the socket is
        // still alive; the response handler tears the connection down after.
        req.pause();
        reject(new VidcallError('invalid_request', 'Request body too large', 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
