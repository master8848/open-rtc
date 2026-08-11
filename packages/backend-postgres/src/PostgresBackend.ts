/**
 * PostgresBackend — vidcall signaling adapter for PostgreSQL LISTEN/NOTIFY.
 *
 * Key facts (research doc §5):
 *  - NOTIFY payloads are capped at **8000 bytes** in the default config — the
 *    adapter chunks anything above 7000 bytes into `ChunkFrame` parts;
 *  - LISTEN must run on a **dedicated client**, NOT a pool (notifications are
 *    only delivered on the connection that ran LISTEN). The adapter never
 *    touches a pool; pass it one long-lived `pg.Client`.
 *  - NOTIFY is transactional and has **no replay** — peers that are not
 *    LISTENing at emit time miss the message (that is correct for live
 *    signaling).
 *  - presence is NOT native: heartbeat rows in a `vidcall_presence` table
 *    (UPSERT on setPresence + heartbeat interval) + NOTIFY fan-out; a stale
 *    sweeper reports peers offline.
 *
 * Browser caveat: `pg` is Node-only. Browser clients need a ws-bridge (a
 * Node server mapping rooms -> channels, e.g. `ws` + `pg`). See README.md.
 */
import type { Envelope, PresenceState } from '@vidcall/protocol';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { BaseSignalingTransport, type BaseOptions, type ParticipantInfo, type ParticipantPresence } from '@vidcall/transport';
import { encodeChunks, isChunkFrame } from '@vidcall/transport/internal';

const { Client } = pg;

/** NOTIFY payload cap minus safety margin (default 8000; docs say < 8000). */
export const POSTGRES_MAX_PAYLOAD = 7000;

export interface PostgresBackendOptions extends BaseOptions {
  /**
   * A DEDICATED, long-lived pg.Client (never a pool). Either provide this or
   * `connectionString` (the adapter then creates and owns its client).
   */
  client?: pg.Client;
  connectionString?: string;
  /** presence table name (heartbeat rows). Default 'vidcall_presence'. Set '' to disable table presence. */
  presenceTable?: string;
  /** heartbeat interval ms. Default 5000 (see BaseOptions). */
  heartbeatMs?: number;
  /** presence stale timeout ms. Default 15_000. */
  presenceTimeoutMs?: number;
}

interface NotificationMsg {
  channel: string;
  payload?: string;
}

/** Presence row as stored in the table + carried over NOTIFY. */
interface PresenceRow {
  id: string;
  state: PresenceState;
  metadata?: Record<string, unknown>;
  lastSeen: number;
}

/** Sanitize a room id into a valid LISTEN/NOTIFY channel name (<= 63 bytes). */
export function channelName(room: string): string {
  // Postgres identifiers: max 63 bytes. 'vidcall_msg_' (12) + '_' (1) + hash (8) = 21 -> 42 for the room.
  const base = room.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const max = 42;
  if (base.length <= max) return `vidcall_msg_${base}`;
  const hash = createHash('sha1').update(room).digest('hex').slice(0, 8);
  return `vidcall_msg_${base.slice(0, max)}_${hash}`;
}

export function presenceChannelName(room: string): string {
  return channelName(room).replace('vidcall_msg_', 'vidcall_presence_');
}

export class PostgresBackend extends BaseSignalingTransport {
  readonly name = 'postgres';
  readonly ordering = 'seq-required' as const; // FIFO per session; cross-session needs seq
  readonly maxPayloadBytes = POSTGRES_MAX_PAYLOAD;

  private readonly client: pg.Client;
  private readonly ownsClient: boolean;
  private readonly presenceTable: string | null;
  private readonly notificationHandler = (msg: NotificationMsg) => this.onNotification(msg);

  constructor(opts: PostgresBackendOptions) {
    super(
      {
        doJoin: () => this.doJoin(),
        doLeave: () => this.doLeave(),
        doSendFrame: (frame) => this.doSendFrame(frame),
        doSetPresence: (state, metadata) => this.doSetPresence(state, metadata),
        doDispose: async () => this.doDispose(),
      },
      {
        ...opts,
        chunkMaxBytes: POSTGRES_MAX_PAYLOAD,
        // Postgres has no native disconnect — heartbeat + sweep are essential
        heartbeatMs: opts.heartbeatMs ?? 5000,
        presenceTimeoutMs: opts.presenceTimeoutMs ?? 15_000,
      },
    );
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else if (opts.connectionString) {
      this.client = new Client({ connectionString: opts.connectionString });
      this.ownsClient = true;
    } else {
      throw new Error('postgres: provide either client or connectionString');
    }
    this.presenceTable = opts.presenceTable === '' ? null : (opts.presenceTable ?? 'vidcall_presence');
  }

  // ------------------------------------------------------------- SDK hooks
  private async doJoin(): Promise<void> {
    const room = this.currentRoom;
    if (room === null) return;
    await this.client.query(`LISTEN ${channelName(room)}`);
    await this.client.query(`LISTEN ${presenceChannelName(room)}`);
    this.client.on('notification', this.notificationHandler);
    if (this.presenceTable) {
      // late joiner: replay current presence from the table (NOTIFY has no replay)
      const res = await this.client.query(
        `SELECT user_id AS id, state, metadata, last_seen AS "lastSeen" FROM ${this.presenceTable} WHERE room = $1`,
        [room],
      );
      for (const row of res.rows as PresenceRow[]) {
        this.deliverPresence({ participantId: row.id, state: row.state, metadata: row.metadata });
        this.touchPresence(row.id);
      }
    }
  }

  private async doLeave(): Promise<void> {
    const room = this.currentRoom;
    this.client.off('notification', this.notificationHandler);
    if (room === null) return;
    await this.client.query(`UNLISTEN ${channelName(room)}`);
    await this.client.query(`UNLISTEN ${presenceChannelName(room)}`);
    const selfId = this.self?.id;
    if (this.presenceTable && selfId) {
      await this.client.query(`DELETE FROM ${this.presenceTable} WHERE room = $1 AND user_id = $2`, [room, selfId]);
    }
    if (selfId) {
      await this.notifyPresence(room, { id: selfId, state: 'offline', lastSeen: Date.now() });
    }
  }

  private async doSendFrame(frame: unknown): Promise<void> {
    const room = this.currentRoom;
    if (room === null) throw new Error('postgres: not joined');
    const json = JSON.stringify(frame);
    // chunk when over the NOTIFY cap (base chunks too; guard here as well)
    const parts =
      new TextEncoder().encode(json).length > POSTGRES_MAX_PAYLOAD
        ? encodeChunks(json, POSTGRES_MAX_PAYLOAD)
        : [frame];
    for (const part of parts) {
      await this.client.query(`NOTIFY ${channelName(room)}, $1`, [JSON.stringify(part)]);
    }
  }

  private async doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) return;
    const row: PresenceRow = { id: selfId, state, metadata, lastSeen: Date.now() };
    if (this.presenceTable) {
      await this.client.query(
        `INSERT INTO ${this.presenceTable} (room, user_id, state, metadata, last_seen) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (room, user_id) DO UPDATE SET state = $3, metadata = $4, last_seen = $5`,
        [room, selfId, state, metadata ?? null, row.lastSeen],
      );
    }
    await this.notifyPresence(room, row);
  }

  private async doDispose(): Promise<void> {
    this.client.off('notification', this.notificationHandler);
    if (this.ownsClient) {
      await this.client.end().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ notifications
  private onNotification(msg: NotificationMsg): void {
    const room = this.currentRoom;
    if (room === null || msg.payload === undefined) return;
    if (msg.channel === channelName(room)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payload);
      } catch {
        return;
      }
      this.deliverFrame(parsed);
      return;
    }
    if (msg.channel === presenceChannelName(room)) {
      try {
        const row = JSON.parse(msg.payload) as PresenceRow;
        if (row.id === this.self?.id) return; // ignore our own echoes
        this.touchPresence(row.id);
        this.deliverPresence({ participantId: row.id, state: row.state, metadata: row.metadata });
      } catch {
        // ignore malformed presence notifications
      }
    }
  }

  private async notifyPresence(room: string, row: PresenceRow): Promise<void> {
    await this.client.query(`NOTIFY ${presenceChannelName(room)}, $1`, [JSON.stringify(row)]);
  }
}

// re-export for tests / tooling
export { isChunkFrame };
