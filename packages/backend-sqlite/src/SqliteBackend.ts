/**
 * SqliteBackend — vidcall signaling adapter for SQLite/libSQL.
 *
 * Research doc (docs/research/backend-adapters.md §6): SQLite has **no server
 * push**. This adapter implements the **same-device mode**: a per-room
 * `BroadcastChannel` (Web platform API; a global in Node ≥ 18) carries
 * envelopes between tabs of the same browser / threads of the same process
 * with ~ms latency and FIFO per-channel ordering. Multi-device calls would
 * need Turso sync, which is eventually consistent (seconds-level) — NOT
 * suitable for an SDP offer/answer handshake; see README for the caveat.
 *
 * Alongside the live channel, every frame is appended to a local libSQL
 * database (`vidcall_signals` log + `vidcall_presence` upserts) — a durable,
 * queryable, offline-first record. The log is **best-effort**: signaling
 * never depends on it, so a read-only or failed database cannot break a call.
 *
 * Presence is backend-native-ish: peers broadcast `presence` frames on the
 * room channel (state + metadata), reply to `presence-sync` requests from
 * late joiners with their current state, and the shared presence sweeper
 * (heartbeat + stale timeout) drops peers whose tab died without a leave.
 */
import type { Envelope, PresenceState } from '@mbsks/protocol';
import { isEnvelope } from '@mbsks/protocol';
import { createClient, type Client } from '@libsql/client';
import { BaseSignalingTransport, type BaseOptions, type ParticipantInfo, type ParticipantPresence } from '@mbsks/transport';

/**
 * Adapter frame cap. BroadcastChannel has no documented message-size limit
 * (structured clone), so this is a safety guard: payloads above 1 MiB are
 * chunked by the shared transport chunker.
 */
export const SQLITE_MAX_PAYLOAD = 1024 * 1024;

export interface SqliteBackendOptions extends BaseOptions {
  /**
   * libSQL client (e.g. `createClient({ url: 'file:local.db' })`).
   * Optional — defaults to an in-memory database owned by the adapter.
   */
  client?: Client;
  /** libSQL URL — alternative to `client`: `':memory:'`, `'file:…'`, `'libsql://…'`. */
  url?: string;
  /** BroadcastChannel name prefix. Default `'vidcall'`. */
  channelPrefix?: string;
}

/** Control frames posted on the room channel (never wire envelopes). */
interface PresenceFrame {
  __vidcall: 'presence';
  participantId: string;
  state: PresenceState;
  metadata?: Record<string, unknown>;
  ts: number;
}

interface PresenceSyncFrame {
  __vidcall: 'presence-sync';
  participantId: string;
}

type ControlFrame = PresenceFrame | PresenceSyncFrame;

const PRESENCE = 'presence';
const PRESENCE_SYNC = 'presence-sync';

function isControlFrame(data: unknown): data is ControlFrame {
  if (data === null || typeof data !== 'object') return false;
  const kind = (data as { __vidcall?: unknown }).__vidcall;
  return kind === PRESENCE || kind === PRESENCE_SYNC;
}

export class SqliteBackend extends BaseSignalingTransport {
  readonly name = 'sqlite';
  /** BroadcastChannel delivers FIFO per channel — same-device ordering is guaranteed. */
  readonly ordering = 'guaranteed' as const;
  readonly maxPayloadBytes = SQLITE_MAX_PAYLOAD;

  private readonly client: Client;
  private readonly ownsClient: boolean;
  private readonly channelPrefix: string;
  private channel: BroadcastChannel | null = null;
  private logReady: Promise<void> | null = null;

  constructor(opts: SqliteBackendOptions = {}) {
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
        heartbeatMs: opts.heartbeatMs ?? 5000,
        presenceTimeoutMs: opts.presenceTimeoutMs ?? 15_000,
      },
    );
    this.channelPrefix = opts.channelPrefix ?? 'vidcall';
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else {
      this.client = createClient({ url: opts.url ?? ':memory:' });
      this.ownsClient = true;
    }
  }

  // ------------------------------------------------------------- SDK hooks
  private async doJoin(): Promise<void> {
    const room = this.currentRoom;
    const self = this.self;
    if (room === null || self === null) return;
    await this.ensureLog();
    const channel = new BroadcastChannel(`${this.channelPrefix}:${room}`);
    this.channel = channel;
    channel.addEventListener('message', (ev: MessageEvent) => this.onChannelMessage(ev.data));
    // announce ourselves: peers reply with their presence so late joiners
    // see who is already in the room
    const sync: PresenceSyncFrame = { __vidcall: PRESENCE_SYNC, participantId: self.id };
    channel.postMessage(sync);
  }

  private async doLeave(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    const selfId = this.self?.id;
    // tell peers we are gone BEFORE closing the channel so the frame ships
    if (channel !== null && selfId !== undefined) {
      const bye: PresenceFrame = { __vidcall: PRESENCE, participantId: selfId, state: 'offline', ts: Date.now() };
      try {
        channel.postMessage(bye);
      } catch {
        /* channel already closed — peers will see us via the stale sweeper */
      }
      channel.close();
    }
    // best-effort: drop our presence row from the local log
    const room = this.currentRoom;
    if (room !== null && selfId !== undefined) {
      await this.logIgnore(() =>
        this.client.execute('DELETE FROM vidcall_presence WHERE room_id = ? AND user_id = ?', [room, selfId]),
      );
    }
  }

  private async doSendFrame(frame: unknown): Promise<void> {
    const channel = this.channel;
    if (channel === null) throw new Error('sqlite: not joined');
    channel.postMessage(frame);
    // best-effort durable signal log
    if (isEnvelope(frame)) {
      await this.logSignal(frame);
    }
  }

  private async doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    const room = this.currentRoom;
    const self = this.self;
    if (room === null || self === null) return;
    const selfId = self.id;
    if (this.channel !== null) {
      const frame: PresenceFrame = { __vidcall: PRESENCE, participantId: selfId, state, metadata, ts: Date.now() };
      this.channel.postMessage(frame);
    }
    await this.logIgnore(() =>
      this.client.execute(
        `INSERT INTO vidcall_presence (room_id, user_id, state, metadata, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET
           state = excluded.state, metadata = excluded.metadata, last_seen = excluded.last_seen`,
        [room, selfId, state, metadata !== undefined ? JSON.stringify(metadata) : null, Date.now()],
      ),
    );
  }

  private async doDispose(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (channel !== null) channel.close();
    if (this.ownsClient) {
      try {
        await this.client.close();
      } catch {
        /* already closed */
      }
    }
  }

  // ------------------------------------------------------------ channel I/O
  private onChannelMessage(data: unknown): void {
    if (this.channel === null) return; // left already — ignore late frames
    if (!isControlFrame(data)) {
      this.deliverFrame(data);
      return;
    }
    if (data.__vidcall === PRESENCE) {
      const p = data as PresenceFrame;
      if (typeof p.participantId !== 'string' || typeof p.state !== 'string') return;
      if (this.self !== null && p.participantId === this.self.id) return; // never deliver our own presence
      this.touchPresence(p.participantId);
      this.deliverPresence({ participantId: p.participantId, state: p.state, metadata: p.metadata });
      return;
    }
    // presence-sync request: reply with our current presence (if any)
    const last = this.lastPresence;
    const selfId = this.self?.id;
    if (last !== null && selfId !== undefined && this.currentRoom !== null && this.channel !== null) {
      const reply: PresenceFrame = { __vidcall: PRESENCE, participantId: selfId, state: last.state, metadata: last.metadata, ts: Date.now() };
      this.channel.postMessage(reply);
    }
  }

  // ------------------------------------------------------------- local log
  private ensureLog(): Promise<void> {
    if (this.logReady === null) {
      this.logReady = this.client
        .batch([
          `CREATE TABLE IF NOT EXISTS vidcall_signals (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             room_id TEXT NOT NULL,
             sender_id TEXT NOT NULL,
             seq INTEGER,
             frame TEXT NOT NULL,
             ts INTEGER NOT NULL
           )`,
          'CREATE INDEX IF NOT EXISTS idx_vidcall_signals_room ON vidcall_signals(room_id, seq)',
          `CREATE TABLE IF NOT EXISTS vidcall_presence (
             room_id TEXT NOT NULL,
             user_id TEXT NOT NULL,
             state TEXT NOT NULL,
             metadata TEXT,
             last_seen INTEGER NOT NULL,
             PRIMARY KEY (room_id, user_id)
           )`,
        ])
        .then(() => undefined)
        .catch(() => undefined);
    }
    return this.logReady;
  }

  private async logSignal(envelope: Envelope): Promise<void> {
    await this.logIgnore(() =>
      this.client.execute(
        'INSERT INTO vidcall_signals (room_id, sender_id, seq, frame, ts) VALUES (?, ?, ?, ?, ?)',
        [envelope.roomId, envelope.senderId, envelope.seq, JSON.stringify(envelope), envelope.ts],
      ),
    );
  }

  /** Best-effort local log — never let a failed DB write break signaling. */
  private async logIgnore(op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch {
      /* best-effort durability only */
    }
  }
}
