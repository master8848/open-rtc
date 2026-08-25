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
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
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
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
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
  const room = await createRoom(services.store, {
    roomId: asString(body.roomId),
    maxParticipants: typeof body.maxParticipants === 'number' ? body.maxParticipants : undefined,
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
    return {
      status: 200,
      body: { room: result.room, participant: result.participant, participants: result.participants },
    };
  }

  // Open mode: still enforce locked/maxParticipants via joinRoom
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
  return {
    status: 200,
    body: { room: result.room, participant: result.participant, participants: result.participants },
  };
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
  const participantId = requireString(body.participantId, 'participantId');
  let role = 'participant' as 'participant' | 'admin';
  if (body.role !== undefined) {
    if (body.role !== 'participant' && body.role !== 'admin') {
      throw errors.invalidRequest('role must be "participant" or "admin"');
    }
    role = body.role;
  }
  const adminToken = ctx.header('adminToken') ?? ctx.header('x-admin-token');
  if (role === 'admin') {
    if (!auth.adminToken || adminToken !== auth.adminToken) {
      throw errors.forbidden('Admin tokens require a valid adminToken header');
    }
  } else if (auth.adminToken && adminToken !== auth.adminToken) {
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
  const storage = await services.recordingStorage.finalize(sessionId);
  const recording = await stopRecording(services.store, sessionId);
  return { status: 200, body: { recording, storage } };
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
  if (policy.e2eeRequired || services.e2ee?.required) {
    // When E2EE is required, we still allow recording but mark it encrypted
    const body = asRecord(ctx.body) ?? {};
    const encrypted = body.encrypted === true ? true : policy.e2eeRequired || services.e2ee?.required ? true : false;
    const rec = await startRecording(services.store, roomId, {
      ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
    });
    // mark encrypted after creation
    if (encrypted) {
      rec.encrypted = true;
      await services.store.putRecording(rec);
    }
    return { status: 201, body: { recording: rec } };
  }
  const body = asRecord(ctx.body) ?? {};
  const rec = await startRecording(services.store, roomId, {
    ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
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
  if (!['kick', 'mute', 'lock', 'unlock'].includes(action)) {
    throw errors.invalidRequest('action must be kick|mute|lock|unlock');
  }
  const targetId = asString(body.targetId);
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
  const result = await moderateRoom(services.store, roomId, claims.participantId, action, targetId);
  // For kick, broadcast leave to remaining members
  if (action === 'kick' && result.kicked) {
    const envelope = { v: 1 as const, type: 'leave' as const, roomId, senderId: result.kicked, sessionId: '', ts: Date.now(), seq: 0, payload: { reason: 'kicked' } } as unknown as import('@mbsks/openrtc-protocol').Envelope;
    services.relay?.broadcast(roomId, envelope);
  }
  return { status: 200, body: { room: result.room, ...(result.kicked ? { kicked: result.kicked } : {}) } };
}

async function turnCredentialsHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  if (!services.turn) throw errors.notImplemented('TURN is not configured on this server');
  // derive room/identity from token
  const auth = services.auth;
  if (!auth) throw errors.authNotConfigured();
  const claims = verifyWithRotation(auth, bearerToken(ctx.header('authorization')));
  const creds = issueTurnCredentials(services.turn, claims.participantId);
  const iceServers = toIceServers(creds);
  return { status: 200, body: { iceServers, ttlSec: services.turn.ttlSec ?? 86400, username: creds.username } };
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
  { method: 'DELETE', pattern: '/rooms/:id', handler: deleteRoomHandler },
  { method: 'GET', pattern: '/rooms/:id/state', handler: stateHandler },
  { method: 'GET', pattern: '/rooms/:id/recordings', handler: recordingsListHandler },
  { method: 'POST', pattern: '/recordings/:sessionId/chunks', handler: chunksHandler },
  { method: 'POST', pattern: '/recordings/:sessionId/finalize', handler: finalizeHandler },
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
      params[p.slice(1)] = decodeURIComponent(ss[i]!);
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
  if (rawBody.length > 0 && !contentType.includes('application/octet-stream')) {
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      malformedJson = true;
    }
  }
  const ctx: RouteContext = {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    params: {},
    body,
    rawBody: contentType.includes('application/octet-stream') ? rawBody : undefined,
    header: (name) => req.headers[name.toLowerCase()] as string | undefined,
  };
  const result = malformedJson
    ? { status: 400, body: { error: { code: 'invalid_request', message: 'Malformed JSON body' } } }
    : await dispatch(services, ctx);
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
