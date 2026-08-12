/**
 * @vidcall/server — framework-agnostic REST handlers + `node:http` server.
 *
 * `dispatch()` is the single router every hosting layer shares: the bare
 * `node:http` server here, the Express router (`express.ts`), the Fastify
 * plugin (`fastify.ts`), and (via the sidecar pattern in `integrations/`)
 * Django/Laravel/Rails proxies.
 *
 * Endpoints (JSON envelope per protocol/schema.json):
 *  - POST   /rooms                        create a room
 *  - POST   /rooms/:id/join               join a room (adds participant)
 *  - POST   /rooms/:id/leave              leave a room
 *  - POST   /rooms/:id/signal             relay one protocol envelope
 *  - GET    /rooms/:id/state              room + participant roster
 *  - GET    /rooms/:id/recordings         recording sessions
 *  - POST   /recordings/:sessionId/chunks upload one media chunk (raw body)
 *  - POST   /recordings/:sessionId/finalize seal a recording session
 */

import http from 'node:http';
import {
  buildJoinEnvelope,
  buildLeaveEnvelope,
  createRoom,
  getRecordings,
  getRoomState,
  handleSignal,
  joinRoom,
  leaveRoom,
  startRecording,
  stopRecording,
} from './core.ts';
import { errors, isVidcallError } from './errors.ts';
import type { Services } from './services.ts';

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
  method: 'GET' | 'POST';
  /** Path pattern: `/rooms/:id/join`. */
  pattern: string;
  handler: (services: Services, ctx: RouteContext) => Promise<RouteResult>;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface JoinBody {
  participantId?: string;
  sessionId?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  /** Alternative nested shape: `{ participant: { participantId, ... } }`. */
  participant?: {
    participantId: string;
    sessionId: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
}

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

async function createRoomHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const body = asRecord(ctx.body) ?? {};
  const room = await createRoom(services.store, {
    roomId: asString(body.roomId),
    maxParticipants: typeof body.maxParticipants === 'number' ? body.maxParticipants : undefined,
    metadata: asRecord(body.metadata),
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

  const result = await joinRoom(services.store, roomId, { participantId, sessionId, displayName, metadata });
  // Broadcast the join so WS peers learn about the newcomer.
  services.relay?.broadcast(
    roomId,
    buildJoinEnvelope(roomId, { participantId, sessionId, displayName, metadata }),
  );
  return { status: 200, body: { room: result.room, participant: result.participant, participants: result.participants } };
}

async function leaveHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const body = asRecord(ctx.body) ?? {};
  const participantId = requireString(body.participantId, 'participantId');
  const reason = asString(body.reason);
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
  const delivery = await handleSignal(services.store, ctx.body);
  services.relay?.broadcast(roomId, delivery.envelope, { exceptSenderId: delivery.envelope.senderId });
  return {
    status: 200,
    body: { seq: (delivery.envelope as { seq: number }).seq, relayedTo: delivery.recipients.map((r) => r.participantId) },
  };
}

async function stateHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const state = await getRoomState(services.store, roomId);
  return { status: 200, body: state };
}

async function recordingsListHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const roomId = ctx.params['id']!;
  const recordings = await getRecordings(services.store, roomId);
  return { status: 200, body: { recordings } };
}

async function chunksHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['sessionId']!;
  if (!services.recordingStorage) {
    throw errors.recordingStorageError('No recording storage configured on this server');
  }
  const recording = await services.store.getRecording(sessionId);
  if (!recording) throw errors.recordingNotFound(sessionId);
  const raw = ctx.rawBody ?? (typeof ctx.body === 'string' ? Buffer.from(ctx.body) : undefined);
  if (!raw || raw.length === 0) throw errors.invalidRequest('Request body must be the raw chunk bytes');
  const indexParam = ctx.query.get('index') ?? ctx.header('x-chunk-index');
  const index = indexParam ? Number(indexParam) : 0;
  if (!Number.isInteger(index) || index < 0) throw errors.invalidRequest('chunk index must be a non-negative integer');
  await services.recordingStorage.saveChunk(sessionId, raw, index);
  return { status: 201, body: { sessionId, index, bytes: raw.length } };
}

async function finalizeHandler(services: Services, ctx: RouteContext): Promise<RouteResult> {
  const sessionId = ctx.params['sessionId']!;
  if (!services.recordingStorage) {
    throw errors.recordingStorageError('No recording storage configured on this server');
  }
  const storage = await services.recordingStorage.finalize(sessionId);
  const recording = await stopRecording(services.store, sessionId);
  return { status: 200, body: { recording, storage } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const routes: readonly Route[] = [
  { method: 'POST', pattern: '/rooms', handler: createRoomHandler },
  { method: 'POST', pattern: '/rooms/:id/join', handler: joinHandler },
  { method: 'POST', pattern: '/rooms/:id/leave', handler: leaveHandler },
  { method: 'POST', pattern: '/rooms/:id/signal', handler: signalHandler },
  { method: 'GET', pattern: '/rooms/:id/state', handler: stateHandler },
  { method: 'GET', pattern: '/rooms/:id/recordings', handler: recordingsListHandler },
  { method: 'POST', pattern: '/recordings/:sessionId/chunks', handler: chunksHandler },
  { method: 'POST', pattern: '/recordings/:sessionId/finalize', handler: finalizeHandler },
];

/** Match a request to a route; returns params or null. */
export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
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
    if (!matched) return { status: 404, body: { error: { code: 'not_found', message: `No route for ${ctx.method} ${ctx.path}` } } };
    return await matched.route.handler(services, { ...ctx, params: matched.params });
  } catch (err) {
    if (isVidcallError(err)) return { status: err.status, body: err.toJSON() };
    if (err instanceof SyntaxError) return { status: 400, body: { error: { code: 'invalid_request', message: 'Malformed JSON body' } } };
    // eslint-disable-next-line no-console
    console.error('[vidcall:server] unhandled error', err);
    return { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } };
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
        reject(errors.invalidRequest('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
