/**
 * PostgresNotifyRelay — distributed Relay backed by Postgres LISTEN/NOTIFY.
 *
 * Alternative to Redis when the deployment only has Postgres. NOTIFY payloads
 * are capped at 7–8 KB, so envelopes that exceed the cap are chunked with a
 * local 7KB chunker (mirrors `@mbsks/openrtc-transport/internal/chunker`).
 * A dedicated `pg.Client` does `LISTEN`; notifications are fanned out to the
 * local RoomHub sockets. The caller supplies the pool (for NOTIFY) and a
 * dedicated listener client — never reuse a pool client for LISTEN.
 *
 * ```ts
 * import { Client, Pool } from 'pg';
 * import { PostgresNotifyRelay } from '@mbsks/openrtc-server/relays/postgres-notify';
 * const pool = new Pool({ connectionString });
 * const listener = new Client({ connectionString });
 * await listener.connect();
 * const relay = new PostgresNotifyRelay(pool, listener);
 * await relay.start();
 * attachWebSocketRelay(server, services, { relay });
 * ```
 */
import type { Envelope } from '@mbsks/openrtc-protocol';
import { isEnvelope } from '@mbsks/openrtc-protocol';
import type { Relay } from '../services.ts';
import { RoomHub } from '../ws.ts';

const CHANNEL = 'vidcall_room';
const CHUNK_MAX_BYTES = 7000;

export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] } | void>;
  on(event: 'notification', handler: (msg: { channel: string; payload?: string }) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

interface WireWrapper {
  envelope: Envelope;
  exceptSenderId?: string;
}

// Local chunker mirror (avoids cross-package dep from server -> transport)
interface ChunkFrame { k: 'chunk'; id: string; i: number; n: number; d: string }
function isChunkFrame(x: unknown): x is ChunkFrame {
  return typeof x === 'object' && x !== null && (x as ChunkFrame).k === 'chunk';
}
function splitUtf8(input: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of input) {
    const b = enc.encode(ch).length;
    if (curBytes + b > maxBytes && cur.length > 0) { parts.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  parts.push(cur);
  return parts;
}
function encodeChunks(json: string, maxBytes: number): ChunkFrame[] {
  const parts = splitUtf8(json, maxBytes);
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return parts.map((d, i) => ({ k: 'chunk', id, i, n: parts.length, d }));
}
class ChunkAssembler {
  private groups = new Map<string, { parts: Map<number, string>; total: number; seen: Set<number>; startedAt: number }>();
  private timeoutMs: number;
  private maxGroups: number;
  constructor(timeoutMs = 10_000, maxGroups = 64) { this.timeoutMs = timeoutMs; this.maxGroups = maxGroups; }
  sweep(now = Date.now()): void {
    for (const [id, g] of this.groups) if (now - g.startedAt > this.timeoutMs) this.groups.delete(id);
  }
  push(frame: unknown): string | undefined {
    if (!isChunkFrame(frame)) return undefined;
    let g = this.groups.get(frame.id);
    if (!g) {
      if (this.groups.size >= this.maxGroups) {
        let oldestId: string | undefined; let oldestTs = Infinity;
        for (const [id, gr] of this.groups) if (gr.startedAt < oldestTs) { oldestTs = gr.startedAt; oldestId = id; }
        if (oldestId !== undefined) this.groups.delete(oldestId);
      }
      g = { parts: new Map(), total: frame.n, seen: new Set(), startedAt: Date.now() };
      this.groups.set(frame.id, g);
    }
    if (frame.i < 0 || frame.i >= g.total) return undefined;
    g.parts.set(frame.i, frame.d); g.seen.add(frame.i);
    if (g.seen.size === g.total) {
      const json = Array.from({ length: g.total }, (_, i) => g.parts.get(i) ?? '').join('');
      this.groups.delete(frame.id); return json;
    }
    return undefined;
  }
}

export class PostgresNotifyRelay implements Relay {
  private readonly local = new RoomHub();
  private readonly assembler = new ChunkAssembler();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly pool: PgPoolLike;
  private readonly listener: PgClientLike;

  constructor(pool: PgPoolLike, listener: PgClientLike) {
    this.pool = pool;
    this.listener = listener;
    this.listener.on('notification', (msg) => {
      if (msg.channel !== CHANNEL) return;
      if (!msg.payload) return;
      let parsed: unknown;
      try { parsed = JSON.parse(msg.payload); } catch { return; }
      let envelope: Envelope | undefined;
      let exceptSenderId: string | undefined;
      if (isChunkFrame(parsed)) {
        const json = this.assembler.push(parsed);
        if (!json) return;
        try {
          const inner: unknown = JSON.parse(json);
          if (inner && typeof inner === 'object' && 'envelope' in (inner as Record<string, unknown>)) {
            const w = inner as WireWrapper;
            if (isEnvelope(w.envelope)) { envelope = w.envelope; exceptSenderId = w.exceptSenderId; }
          } else if (isEnvelope(inner)) envelope = inner as Envelope;
        } catch { return; }
      } else if (parsed && typeof parsed === 'object' && 'envelope' in (parsed as Record<string, unknown>)) {
        const w = parsed as WireWrapper;
        if (isEnvelope(w.envelope)) { envelope = w.envelope; exceptSenderId = w.exceptSenderId; }
      } else if (isEnvelope(parsed)) envelope = parsed as Envelope;
      if (!envelope) return;
      this.local.broadcast(envelope.roomId, envelope, exceptSenderId ? { exceptSenderId } : undefined);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.listener.query(`LISTEN ${CHANNEL}`);
    this.started = true;
    this.sweepTimer = setInterval(() => this.assembler.sweep(), 10_000);
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    await this.listener.query(`UNLISTEN ${CHANNEL}`).catch(() => {});
    this.started = false;
  }

  attach(roomId: string, socket: import('ws').WebSocket, senderId: string, sessionId: string): void {
    this.local.attach(roomId, socket, senderId, sessionId);
  }
  detach(roomId: string, socket: import('ws').WebSocket): void { this.local.detach(roomId, socket); }
  broadcast(roomId: string, envelope: Envelope, opts?: { exceptSenderId?: string }): void {
    this.local.broadcast(roomId, envelope, opts);
    const wrapper: WireWrapper = opts?.exceptSenderId ? { envelope, exceptSenderId: opts.exceptSenderId } : { envelope };
    const json = JSON.stringify(wrapper);
    const byteLen = new TextEncoder().encode(json).length;
    const frames: unknown[] = byteLen > CHUNK_MAX_BYTES ? encodeChunks(json, CHUNK_MAX_BYTES) : [wrapper];
    for (const frame of frames) {
      const payload = JSON.stringify(frame);
      void this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch(() => {});
    }
  }
  metaFor(socket: import('ws').WebSocket): { roomId: string | null; senderId: string | null; sessionId: string | null } | undefined {
    return this.local.metaFor(socket);
  }
  clientCount(roomId: string): number { return this.local.clientCount(roomId); }
  get hub(): RoomHub { return this.local; }
}
