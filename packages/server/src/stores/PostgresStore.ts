/**
 * PostgreSQL `Store` backed by `pg`.
 *
 * Accepts a `pg.Pool`, a `pg.Client`, or a connection string. Tables are
 * JSON documents + indexed columns; signal seqs come from a `BIGINT
 * GENERATED ALWAYS AS IDENTITY` column so per-room ordering is atomic even
 * under concurrency.
 *
 * `pg` is an **optional peer dependency** and is loaded lazily (only when
 * this store is constructed with a connection string), so importing the
 * module never loads the driver. Install it next to `@mbsks/openrtc-server`:
 *
 * ```
 * npm i pg
 * ```
 *
 * ```
 * import { PostgresStore } from '@mbsks/openrtc-server/stores/postgres';
 * const store = new PostgresStore('postgres://user:pass@localhost/vidcall');
 * await store.bootstrap();
 * ```
 *
 * For real-time push (LISTEN/NOTIFY + a WebSocket bridge) see the
 * `backend-postgres` adapter; this store is the durable state + REST/WS
 * relay substrate.
 */

import type { Pool, PoolClient } from 'pg';
import type { Envelope } from '@mbsks/openrtc-protocol';
import type { Store } from '../store.ts';
import type { BanEntry, LobbyEntry, Participant, Poll, RecordingSession, Room, StoredSignal } from '../types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vidcall_rooms (
  room_id   TEXT PRIMARY KEY,
  room_json JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS vidcall_participants (
  room_id        TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_json JSONB NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
CREATE TABLE IF NOT EXISTS vidcall_signals (
  room_id       TEXT NOT NULL,
  seq           BIGINT GENERATED ALWAYS AS IDENTITY,
  envelope_json JSONB NOT NULL,
  received_at   BIGINT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_vidcall_signals_room ON vidcall_signals (room_id);
CREATE TABLE IF NOT EXISTS vidcall_recordings (
  session_id     TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL,
  recording_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vidcall_recordings_room ON vidcall_recordings (room_id);
CREATE TABLE IF NOT EXISTS vidcall_bans (
  room_id        TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  ban_json       JSONB NOT NULL,
  expires_at     BIGINT,
  PRIMARY KEY (room_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_vidcall_bans_room ON vidcall_bans (room_id);
CREATE TABLE IF NOT EXISTS vidcall_lobby (
  room_id        TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  enqueued_at    BIGINT NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
CREATE TABLE IF NOT EXISTS vidcall_hand_queue (
  room_id        TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  enqueued_at    BIGINT NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
CREATE TABLE IF NOT EXISTS vidcall_polls (
  room_id   TEXT NOT NULL,
  poll_id   TEXT NOT NULL,
  poll_json JSONB NOT NULL,
  PRIMARY KEY (room_id, poll_id)
);
CREATE INDEX IF NOT EXISTS idx_vidcall_polls_room ON vidcall_polls (room_id);
`;

type Queryable = Pick<Pool | PoolClient, 'query'>;

type PgModule = typeof import('pg');

/**
 * Lazy driver load: importing this module must never resolve `pg` — only a
 * store constructed with a connection string touches the driver, at first
 * query. Missing installs surface as an actionable error.
 */
async function loadPg(): Promise<PgModule> {
  try {
    return await import('pg');
  } catch {
    throw new Error(
      "PostgresStore requires the optional peer dependency 'pg'. " +
        'Install it next to @mbsks/openrtc-server: npm i pg',
    );
  }
}

export class PostgresStore implements Store {
  private readonly source: Queryable | string;
  private lazyPool: Pool | null = null;
  private bootstrapped = false;

  constructor(poolOrConnectionString: Queryable | string) {
    this.source = poolOrConnectionString;
  }

  /**
   * The injected pool/client when one was passed; otherwise lazily create
   * the driver-backed pool from the connection string on first use.
   */
  private async connect(): Promise<Queryable> {
    if (typeof this.source !== 'string') return this.source;
    if (!this.lazyPool) {
      const { Pool } = await loadPg();
      this.lazyPool = new Pool({ connectionString: this.source });
    }
    return this.lazyPool;
  }

  /** Create tables if missing. Idempotent; call once at boot. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const pool = await this.connect();
    await pool.query(SCHEMA);
    this.bootstrapped = true;
  }

  // ---- rooms -------------------------------------------------------------
  async getRoom(roomId: string): Promise<Room | null> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT room_json FROM vidcall_rooms WHERE room_id = $1', [
      roomId,
    ]);
    return rows[0] ? (rows[0].room_json as Room) : null;
  }

  async putRoom(room: Room): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_rooms (room_id, room_json) VALUES ($1, $2)
       ON CONFLICT (room_id) DO UPDATE SET room_json = EXCLUDED.room_json`,
      [room.roomId, JSON.stringify(room)],
    );
  }

  async deleteRoom(roomId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query('DELETE FROM vidcall_rooms WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_participants WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_signals WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_recordings WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_bans WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_lobby WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_hand_queue WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM vidcall_polls WHERE room_id = $1', [roomId]);
  }

  // ---- participants ------------------------------------------------------
  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    const pool = await this.connect();
    const { rows } = await pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = $1 AND participant_id = $2',
      [roomId, participantId],
    );
    return rows[0] ? (rows[0].participant_json as Participant) : null;
  }

  async putParticipant(participant: Participant): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_participants (room_id, participant_id, participant_json) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, participant_id) DO UPDATE SET participant_json = EXCLUDED.participant_json`,
      [participant.roomId, participant.participantId, JSON.stringify(participant)],
    );
  }

  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      'DELETE FROM vidcall_participants WHERE room_id = $1 AND participant_id = $2',
      [roomId, participantId],
    );
  }

  async listParticipants(roomId: string): Promise<Participant[]> {
    const pool = await this.connect();
    const { rows } = await pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = $1',
      [roomId],
    );
    return (rows.map((r) => r.participant_json as Participant) as Participant[]).sort(
      (a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId),
    );
  }

  // ---- signals -----------------------------------------------------------
  async putSignal(signal: {
    roomId: string;
    envelope: Envelope;
    receivedAt: number;
  }): Promise<StoredSignal> {
    const pool = await this.connect();
    const { rows } = await pool.query(
      `INSERT INTO vidcall_signals (room_id, envelope_json, received_at) VALUES ($1, $2, $3)
       RETURNING seq`,
      [signal.roomId, JSON.stringify(signal.envelope), signal.receivedAt],
    );
    const seq = Number(rows[0]!.seq);
    return { roomId: signal.roomId, seq, envelope: signal.envelope, receivedAt: signal.receivedAt };
  }

  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    const pool = await this.connect();
    const { rows } = await pool.query(
      'SELECT seq, envelope_json, received_at FROM vidcall_signals WHERE room_id = $1 AND seq > $2 ORDER BY seq',
      [roomId, since],
    );
    return rows.map((r) => ({
      roomId,
      seq: Number(r.seq),
      envelope: r.envelope_json as Envelope,
      receivedAt: Number(r.received_at),
    }));
  }

  // ---- recordings --------------------------------------------------------
  async putRecording(recording: RecordingSession): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_recordings (session_id, room_id, recording_json) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET recording_json = EXCLUDED.recording_json`,
      [recording.sessionId, recording.roomId, JSON.stringify(recording)],
    );
  }

  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    const pool = await this.connect();
    const { rows } = await pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE room_id = $1',
      [roomId],
    );
    return rows.map((r) => r.recording_json as RecordingSession);
  }

  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    const pool = await this.connect();
    const { rows } = await pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE session_id = $1',
      [sessionId],
    );
    return rows[0] ? (rows[0].recording_json as RecordingSession) : null;
  }

  async deleteRecording(sessionId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query('DELETE FROM vidcall_recordings WHERE session_id = $1', [sessionId]);
  }

  async listAllRecordings(): Promise<RecordingSession[]> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT recording_json FROM vidcall_recordings');
    return rows.map((r) => r.recording_json as RecordingSession);
  }

  // ---- bans --------------------------------------------------------------
  async listBans(roomId: string): Promise<BanEntry[]> {
    const pool = await this.connect();
    const now = Date.now();
    await pool.query('DELETE FROM vidcall_bans WHERE room_id = $1 AND expires_at IS NOT NULL AND expires_at <= $2', [roomId, now]);
    const { rows } = await pool.query('SELECT ban_json FROM vidcall_bans WHERE room_id = $1', [roomId]);
    return rows.map((r) => r.ban_json as BanEntry);
  }

  async getBan(roomId: string, participantId: string): Promise<BanEntry | null> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT ban_json, expires_at FROM vidcall_bans WHERE room_id = $1 AND participant_id = $2', [roomId, participantId]);
    if (!rows[0]) return null;
    const entry = rows[0].ban_json as BanEntry;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      await pool.query('DELETE FROM vidcall_bans WHERE room_id = $1 AND participant_id = $2', [roomId, participantId]);
      return null;
    }
    return entry;
  }

  async putBan(roomId: string, entry: BanEntry): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_bans (room_id, participant_id, ban_json, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, participant_id) DO UPDATE SET ban_json = EXCLUDED.ban_json, expires_at = EXCLUDED.expires_at`,
      [roomId, entry.participantId, JSON.stringify(entry), entry.expiresAt ?? null],
    );
  }

  async deleteBan(roomId: string, participantId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query('DELETE FROM vidcall_bans WHERE room_id = $1 AND participant_id = $2', [roomId, participantId]);
  }

  // ---- lobby -------------------------------------------------------------
  async listLobby(roomId: string): Promise<LobbyEntry[]> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT participant_id, enqueued_at FROM vidcall_lobby WHERE room_id = $1 ORDER BY enqueued_at', [roomId]);
    return rows.map((r) => ({ participantId: r.participant_id as string, enqueuedAt: Number(r.enqueued_at) }));
  }

  async putLobby(roomId: string, participantId: string, enqueuedAt: number): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_lobby (room_id, participant_id, enqueued_at) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, participant_id) DO UPDATE SET enqueued_at = EXCLUDED.enqueued_at`,
      [roomId, participantId, enqueuedAt],
    );
  }

  async deleteLobby(roomId: string, participantId: string): Promise<boolean> {
    const pool = await this.connect();
    const { rowCount } = await pool.query('DELETE FROM vidcall_lobby WHERE room_id = $1 AND participant_id = $2', [roomId, participantId]);
    return (rowCount ?? 0) > 0;
  }

  // ---- hand queue --------------------------------------------------------
  async listHandQueue(roomId: string): Promise<string[]> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT participant_id FROM vidcall_hand_queue WHERE room_id = $1 ORDER BY enqueued_at', [roomId]);
    return rows.map((r) => r.participant_id as string);
  }

  async addHand(roomId: string, participantId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_hand_queue (room_id, participant_id, enqueued_at) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, participant_id) DO NOTHING`,
      [roomId, participantId, Date.now()],
    );
  }

  async removeHand(roomId: string, participantId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query('DELETE FROM vidcall_hand_queue WHERE room_id = $1 AND participant_id = $2', [roomId, participantId]);
  }

  // ---- polls -------------------------------------------------------------
  async listPolls(roomId: string): Promise<Poll[]> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT poll_json FROM vidcall_polls WHERE room_id = $1', [roomId]);
    return rows.map((r) => r.poll_json as Poll);
  }

  async getPoll(roomId: string, pollId: string): Promise<Poll | null> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT poll_json FROM vidcall_polls WHERE room_id = $1 AND poll_id = $2', [roomId, pollId]);
    return rows[0] ? (rows[0].poll_json as Poll) : null;
  }

  async putPoll(roomId: string, poll: Poll): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      `INSERT INTO vidcall_polls (room_id, poll_id, poll_json) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, poll_id) DO UPDATE SET poll_json = EXCLUDED.poll_json`,
      [roomId, poll.id, JSON.stringify(poll)],
    );
  }

  async votePoll(roomId: string, pollId: string, participantId: string, option: string): Promise<boolean> {
    const pool = await this.connect();
    const { rows } = await pool.query('SELECT poll_json FROM vidcall_polls WHERE room_id = $1 AND poll_id = $2', [roomId, pollId]);
    if (!rows[0]) return false;
    const poll = rows[0].poll_json as Poll;
    if (!poll.options.includes(option)) return false;
    poll.votes[participantId] = option;
    await pool.query('UPDATE vidcall_polls SET poll_json = $1 WHERE room_id = $2 AND poll_id = $3', [JSON.stringify(poll), roomId, pollId]);
    return true;
  }

  /** Close the underlying pool (call when shutting down). */
  async close(): Promise<void> {
    if (this.lazyPool) {
      await this.lazyPool.end();
      this.lazyPool = null;
    } else if (
      typeof this.source !== 'string' &&
      'end' in this.source &&
      typeof this.source.end === 'function'
    ) {
      await this.source.end();
    }
  }
}
