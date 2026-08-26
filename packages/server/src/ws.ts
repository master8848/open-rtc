/**
 * @mbsks/openrtc-server — WebSocket signaling relay.
 *
 * `attachWebSocketRelay(server, services)` upgrades `GET /ws?roomId=...`
 * connections on any `node:http` server (standalone, or the one Express /
 * Fastify / a reverse proxy already listens on) and relays protocol
 * envelopes between room members.
 *
 * Auth mode (`services.auth` set): clients must connect with
 * `?token=<token>`; the join is rejected with an error envelope + close
 * (4401) when the token is missing/invalid, scoped to another room, or
 * bound to another sender. Open mode (no auth) keeps the legacy behavior:
 *
 *  1. Client connects to `/ws?roomId=<id>` and sends a `join` envelope.
 *  2. The relay registers the participant (core `joinRoom`), replies with a
 *     server-only `{ type: 'joined', room, participants }` message, and
 *     broadcasts the join envelope to the room.
 *  3. Every further envelope (`offer`/`answer`/`ice`/`presence`/`reaction`/
 *     `chat`/...) is persisted (core `handleSignal`) and relayed to the
 *     other members — the sender never receives its own signal back, mirror
 *     the client engine's expectation.
 *  4. A `leave` envelope (or a dropped connection) removes the participant
 *     and broadcasts the leave to the remaining members.
 *
 * `RoomHub` doubles as `Services.relay`, so REST mutations (HTTP join/leave/
 * signal) fan out to the same connected sockets.
 */

import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createEnvelope, isEnvelope, type Envelope } from '@mbsks/openrtc-protocol';
import { AuthError, verifyToken, verifyTokenWithRotation } from './auth.ts';
import {
  buildLeaveEnvelope,
  getRoomPolicy,
  handleSignal,
  joinRoom,
  leaveRoom,
  type ParticipantInput,
} from './core.ts';
import type { Relay, Services } from './services.ts';
import type { Participant } from './types.ts';

/** Server-only message sent to a client right after a successful join. */
export interface JoinedMessage {
  type: 'joined';
  roomId: string;
  room: import('./types.js').Room;
  participants: Participant[];
}

interface SocketMeta {
  roomId: string | null;
  senderId: string | null;
  sessionId: string | null;
}

/** In-process room → connected sockets registry; implements `Relay`. */
export class RoomHub implements Relay {
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly meta = new WeakMap<WebSocket, SocketMeta>();

  attach(roomId: string, socket: WebSocket, senderId: string, sessionId: string): void {
    this.meta.set(socket, { roomId, senderId, sessionId });
    let set = this.rooms.get(roomId);
    if (!set) {
      set = new Set();
      this.rooms.set(roomId, set);
    }
    set.add(socket);
  }

  detach(roomId: string, socket: WebSocket): void {
    this.meta.delete(socket);
    const set = this.rooms.get(roomId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.rooms.delete(roomId);
  }

  metaFor(socket: WebSocket): SocketMeta | undefined {
    return this.meta.get(socket);
  }

  broadcast(roomId: string, envelope: Envelope, opts?: { exceptSenderId?: string }): void {
    const set = this.rooms.get(roomId);
    if (!set) return;
    const payload = JSON.stringify(envelope);
    for (const socket of set) {
      const m = this.meta.get(socket);
      if (opts?.exceptSenderId && m?.senderId === opts.exceptSenderId) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  clientCount(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }
}

export interface WebSocketRelayOptions {
  /** Upgrade path; default `/ws`. */
  path?: string;
  /** Per-message payload cap; default 8 MiB (SDP/ICE are a few KB). */
  maxPayloadBytes?: number;
  /** Optional pluggable relay (e.g. RedisRelay, PostgresNotifyRelay). When omitted a local RoomHub is used. */
  relay?: Relay;
}

export interface WebSocketRelay {
  hub: Relay;
  /** All live sockets (diagnostics/tests). */
  clients: Set<WebSocket>;
  /** Close every connection and stop accepting upgrades. */
  close(): Promise<void>;
}

/**
 * Attach the WS relay to an existing `node:http` server. Returns a handle
 * with `close()` for shutdown (used by tests and graceful-stop guides).
 */
export function attachWebSocketRelay(
  server: http.Server,
  services: Services,
  opts: WebSocketRelayOptions = {},
): WebSocketRelay {
  const path = opts.path ?? '/ws';
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: opts.maxPayloadBytes ?? 8 * 1024 * 1024,
  });
  const hub: Relay = opts.relay ?? new RoomHub();
  // The hub doubles as Services.relay so REST mutations (HTTP join/leave/
  // signal) fan out to the same connected sockets. Requires the caller to
  // pass the SAME services object it gave the HTTP router.
  // When a pluggable relay (RedisRelay / PostgresNotifyRelay) is supplied
  // it wraps the local RoomHub internally, so we store whatever was chosen.
  services.relay = hub;
  const clients = new Set<WebSocket>();
  /** Raw `?token=` query value per socket (verified at join, auth mode). */
  const tokens = new WeakMap<WebSocket, string>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const roomId = url.searchParams.get('roomId');
    if (!roomId) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => {
      tokens.set(ws, token);
      wss.emit('connection', ws, req, url);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    clients.add(socket);
    socket.on('message', (data) => {
      void handleMessage(services, hub, socket, data.toString(), tokens);
    });
    socket.on('close', () => {
      clients.delete(socket);
      tokens.delete(socket);
      void handleClose(services, hub, socket);
    });
    socket.on('error', () => {
      // Errors surface via close(); nothing else to do.
    });
  });

  return {
    hub,
    clients,
    async close() {
      for (const socket of [...clients]) {
        socket.close(1001, 'server shutting down');
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.removeAllListeners('upgrade');
    },
  };
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function errorEnvelope(roomId: string, code: string, message: string): Envelope {
  return createEnvelope('error', {
    roomId,
    senderId: 'server',
    sessionId: 'server',
    payload: { code, message },
  });
}

/**
 * Verify the socket's `?token=` against the join target (auth mode only).
 * On failure, sends an error envelope and closes the socket with 4401
 * (application range, "unauthorized").
 *
 * @returns true when the join may proceed (or auth is not configured).
 */
function authenticateSocket(
  services: Services,
  tokens: WeakMap<WebSocket, string>,
  socket: WebSocket,
  roomId: string,
  senderId: string,
): boolean {
  const auth = services.auth;
  if (!auth) return true; // legacy open mode
  try {
    const token = tokens.get(socket) ?? '';
    const secrets = auth.previousSecrets?.length ? [auth.secret, ...auth.previousSecrets] : [auth.secret];
    const claims = secrets.length > 1 ? verifyTokenWithRotation(secrets, token) : verifyToken(auth.secret, token);
    if (claims.roomId !== roomId) {
      throw new AuthError(
        'forbidden',
        `Token is scoped to room ${claims.roomId}, not ${roomId} (tokens are room-scoped)`,
      );
    }
    if (claims.participantId !== senderId) {
      throw new AuthError(
        'forbidden',
        `Token is bound to participant ${claims.participantId}, not ${senderId}`,
      );
    }
    return true;
  } catch (err) {
    const code = errCode(err);
    sendJson(socket, errorEnvelope(roomId, code, errMessage(err)));
    socket.close(4401, code);
  }
  return false;
}

async function handleMessage(
  services: Services,
  hub: Relay,
  socket: WebSocket,
  raw: string,
  tokens: WeakMap<WebSocket, string>,
): Promise<void> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    sendJson(socket, errorEnvelope('unknown', 'invalid_json', 'Message is not valid JSON'));
    return;
  }
  if (!isEnvelope(envelope)) {
    const roomId =
      typeof envelope === 'object' &&
      envelope !== null &&
      typeof (envelope as { roomId?: unknown }).roomId === 'string'
        ? (envelope as { roomId: string }).roomId
        : 'unknown';
    sendJson(
      socket,
      errorEnvelope(roomId, 'invalid_envelope', 'Envelope failed protocol validation'),
    );
    return;
  }

  const meta = hub.metaFor?.(socket);

  if (!meta?.roomId) {
    // First message must be a join for the roomId the client connected with.
    if (envelope.type !== 'join') {
      sendJson(socket, errorEnvelope(envelope.roomId, 'must_join', 'Send a join envelope first'));
      return;
    }
    await handleJoin(services, hub, socket, envelope, tokens);
    return;
  }

  if (envelope.roomId !== meta.roomId) {
    sendJson(
      socket,
      errorEnvelope(envelope.roomId, 'room_mismatch', `Socket is bound to room ${meta.roomId}`),
    );
    return;
  }

  try {
    if (envelope.type === 'leave') {
      const result = await leaveRoom(services.store, envelope.roomId, envelope.senderId, {
        envelope,
      });
      hub.detach(envelope.roomId, socket);
      if (result.delivery) {
        hub.broadcast(envelope.roomId, result.delivery.envelope, {
          exceptSenderId: envelope.senderId,
        });
      }
      return;
    }
    const delivery = await handleSignal(services.store, envelope);
    hub.broadcast(envelope.roomId, delivery.envelope, {
      exceptSenderId: envelope.senderId,
    });
  } catch (err) {
    sendJson(socket, errorEnvelope(envelope.roomId, errCode(err), errMessage(err)));
  }
}

async function handleJoin(
  services: Services,
  hub: Relay,
  socket: WebSocket,
  envelope: Envelope & { type: 'join' },
  tokens: WeakMap<WebSocket, string>,
): Promise<void> {
  const roomId = envelope.roomId;
  // Auth mode: reject the join (error envelope + close) when the `?token=`
  // is missing/invalid, scoped to another room, or bound to another sender.
  if (!authenticateSocket(services, tokens, socket, roomId, envelope.senderId)) return;
  const payload = envelope.payload;
  const input: ParticipantInput = {
    participantId: envelope.senderId,
    sessionId: envelope.sessionId,
    ...(payload &&
    typeof payload === 'object' &&
    'displayName' in payload &&
    typeof payload.displayName === 'string'
      ? { displayName: payload.displayName }
      : {}),
    ...(payload && typeof payload === 'object' && 'metadata' in payload && payload.metadata
      ? { metadata: payload.metadata as Record<string, unknown> }
      : {}),
  };
  try {
    // Enforce room policy at WS join as well: locked / e2eeRequired
    const roomForPolicy = await services.store.getRoom(roomId);
    const policy = roomForPolicy ? getRoomPolicy(roomForPolicy) : {};
    if (policy.locked) {
      // check if sender is moderator/admin via token claims when available
      const auth = services.auth;
      if (auth) {
        const token = tokens.get(socket) ?? '';
        try {
          const secrets = auth.previousSecrets?.length ? [auth.secret, ...auth.previousSecrets] : [auth.secret];
          const claims = secrets.length > 1 ? verifyTokenWithRotation(secrets, token) : verifyToken(auth.secret, token);
          const isModerator = policy.moderatorIds?.includes(claims.participantId) ?? false;
          const isPrivileged = claims.role === 'admin' || isModerator;
          if (!isPrivileged) {
            sendJson(socket, errorEnvelope(roomId, 'forbidden', `Room ${roomId} is locked`));
            socket.close(4401, 'forbidden');
            return;
          }
        } catch {
          // already handled by authenticateSocket; ignore
        }
      } else {
        sendJson(socket, errorEnvelope(roomId, 'forbidden', `Room ${roomId} is locked`));
        socket.close(4401, 'forbidden');
        return;
      }
    }
    // e2eeRequired: require token e2ee flag if auth present
    if (policy.e2eeRequired && services.auth) {
      const token = tokens.get(socket) ?? '';
      try {
        const secrets = services.auth.previousSecrets?.length ? [services.auth.secret, ...services.auth.previousSecrets] : [services.auth.secret];
        const claims = secrets.length > 1 ? verifyTokenWithRotation(secrets, token) : verifyToken(services.auth.secret, token);
        if (claims.e2ee !== true && claims.role !== 'admin') {
          sendJson(socket, errorEnvelope(roomId, 'forbidden', 'Room requires E2EE-capable token (e2ee:true)'));
          socket.close(4401, 'forbidden');
          return;
        }
      } catch {
        // auth already failed earlier
      }
    }
    const room = await services.store.getRoom(roomId);
    const checkPolicy = room ? getRoomPolicy(room) : {};
    const auth = services.auth;
    let actorRole: string | undefined;
    let isModerator = false;
    if (auth) {
      try {
        const token = tokens.get(socket) ?? '';
        const secrets = auth.previousSecrets?.length ? [auth.secret, ...auth.previousSecrets] : [auth.secret];
        const claims = secrets.length > 1 ? verifyTokenWithRotation(secrets, token) : verifyToken(auth.secret, token);
        actorRole = claims.role;
        isModerator = checkPolicy.moderatorIds?.includes(claims.participantId) ?? false;
      } catch { /* ignore */ }
    }
    const result = await joinRoom(services.store, roomId, input, { actorRole, isModerator });
    // Persist the join envelope into the signal log + compute recipients.
    const delivery = await handleSignal(services.store, envelope);
    hub.attach(roomId, socket, envelope.senderId, envelope.sessionId);
    // Peers learn about the newcomer; the joiner gets the `joined` ack below.
    hub.broadcast(roomId, delivery.envelope, { exceptSenderId: envelope.senderId });
    // Push notification trigger on offline join (if push service configured)
    if (services.push) {
      void services.push.notify(roomId, { event: 'join', participantId: envelope.senderId }).catch(() => {});
    }
    // webhook dispatch for join
    if (services.webhooks?.length) {
      const { dispatchWebhooks } = await import('./webhooks.ts');
      void dispatchWebhooks(services.webhooks, { event: 'join', roomId, payload: { participantId: envelope.senderId }, ts: Date.now() });
    }
    const joined: JoinedMessage = {
      type: 'joined',
      roomId,
      room: result.room,
      participants: result.participants,
    };
    sendJson(socket, joined);
  } catch (err) {
    // lobby waiting webhook when locked
    if ((err as { code?: string })?.code === 'forbidden' && String((err as Error).message).includes('lobby')) {
      if (services.webhooks?.length) {
        const { dispatchWebhooks } = await import('./webhooks.ts');
        void dispatchWebhooks(services.webhooks, { event: 'lobby.waiting', roomId, payload: { participantId: envelope.senderId }, ts: Date.now() });
      }
    }
    sendJson(socket, errorEnvelope(roomId, errCode(err), errMessage(err)));
  }
}

async function handleClose(services: Services, hub: Relay, socket: WebSocket): Promise<void> {
  const meta = hub.metaFor?.(socket);
  if (!meta?.roomId || !meta.senderId) return;
  const roomId = meta.roomId;
  const participant = await services.store.getParticipant(roomId, meta.senderId).catch(() => null);
  if (!participant) {
    hub.detach(roomId, socket);
    return;
  }
  const envelope = buildLeaveEnvelope(roomId, participant, 'disconnect');
  try {
    const result = await leaveRoom(services.store, roomId, meta.senderId, { envelope });
    hub.detach(roomId, socket);
    if (result.delivery) {
      hub.broadcast(roomId, result.delivery.envelope, { exceptSenderId: meta.senderId });
    }
  } catch {
    hub.detach(roomId, socket);
  }
}

function errCode(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return 'internal_error';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Internal server error';
}
