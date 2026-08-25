/**
 * MySQL `Store` backed by `mysql2/promise`.
 *
 * Accepts a `mysql2/promise` Pool or a connection options object (or a
 * URL string). Signal seqs use a per-(room) AUTO_INCREMENT column so
 * ordering is atomic under concurrency.
 *
 * `mysql2` is an **optional peer dependency** and is loaded lazily (only
 * when this store has to create its own pool), so importing the module
 * never loads the driver. Install it next to `@mbsks/server`:
 *
 * ```
 * npm i mysql2
 * ```
 *
 * ```
 * import { MysqlStore } from '@mbsks/server/stores/mysql';
 * const store = new MysqlStore({ host: '127.0.0.1', port: 3306, user: 'vidcall', password: '...', database: 'vidcall' });
 * await store.bootstrap();
 * ```
 */

import type { Pool, PoolOptions } from 'mysql2/promise';
import type { Envelope } from '@mbsks/protocol';
import type { Store } from '../store.ts';
import type { Participant, RecordingSession, Room, StoredSignal } from '../types.ts';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS vidcall_rooms (
    room_id   VARCHAR(255) PRIMARY KEY,
    room_json JSON NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vidcall_participants (
    room_id         VARCHAR(255) NOT NULL,
    participant_id  VARCHAR(255) NOT NULL,
    participant_json JSON NOT NULL,
    PRIMARY KEY (room_id, participant_id)
  )`,
  `CREATE TABLE IF NOT EXISTS vidcall_signals (
    seq           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    room_id       VARCHAR(255) NOT NULL,
    envelope_json JSON NOT NULL,
    received_at   BIGINT NOT NULL,
    KEY idx_vidcall_signals_room (room_id)
  )`,
  `CREATE TABLE IF NOT EXISTS vidcall_recordings (
    session_id     VARCHAR(255) PRIMARY KEY,
    room_id        VARCHAR(255) NOT NULL,
    recording_json JSON NOT NULL,
    INDEX idx_vidcall_recordings_room (room_id)
  )`,
];

type MysqlPromiseModule = typeof import('mysql2/promise');

/**
 * Lazy driver load: importing this module must never resolve `mysql2` — only
 * a store that creates its own pool touches the driver, at first query.
 * Missing installs surface as an actionable error.
 */
async function loadMysql(): Promise<MysqlPromiseModule> {
  try {
    return await import('mysql2/promise');
  } catch {
    throw new Error(
      "MysqlStore requires the optional peer dependency 'mysql2'. " +
        'Install it next to @mbsks/server: npm i mysql2',
    );
  }
}

export class MysqlStore implements Store {
  private readonly source: Pool | PoolOptions | string;
  private lazyPool: Pool | null = null;
  private bootstrapped = false;

  constructor(poolOrOptions: Pool | PoolOptions | string) {
    this.source = poolOrOptions;
  }

  /**
   * The injected pool when one was passed; otherwise lazily create the
   * driver-backed pool from the URL/options on first use.
   */
  private async connect(): Promise<Pool> {
    if (isPool(this.source)) return this.source;
    if (!this.lazyPool) {
      const { createPool } = await loadMysql();
      this.lazyPool =
        typeof this.source === 'string'
          ? createPool({ ...parseConnectionUrl(this.source), connectTimeout: 5000 })
          : createPool({ ...this.source, connectTimeout: 5000 });
    }
    return this.lazyPool;
  }

  /** Create tables if missing. Idempotent; call once at boot. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const pool = await this.connect();
    for (const statement of SCHEMA_STATEMENTS) {
      await pool.query(statement);
    }
    this.bootstrapped = true;
  }

  // ---- rooms -------------------------------------------------------------
  async getRoom(roomId: string): Promise<Room | null> {
    const pool = await this.connect();
    const [rows] = await pool.query('SELECT room_json FROM vidcall_rooms WHERE room_id = ?', [
      roomId,
    ]);
    const row = firstRow(rows);
    return row ? (row.room_json as Room) : null;
  }

  async putRoom(room: Room): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      'INSERT INTO vidcall_rooms (room_id, room_json) VALUES (?, ?) ' +
        'ON DUPLICATE KEY UPDATE room_json = VALUES(room_json)',
      [room.roomId, JSON.stringify(room)],
    );
  }

  async deleteRoom(roomId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query('DELETE FROM vidcall_rooms WHERE room_id = ?', [roomId]);
    await pool.query('DELETE FROM vidcall_participants WHERE room_id = ?', [roomId]);
    await pool.query('DELETE FROM vidcall_signals WHERE room_id = ?', [roomId]);
    await pool.query('DELETE FROM vidcall_recordings WHERE room_id = ?', [roomId]);
  }

  // ---- participants ------------------------------------------------------
  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    const pool = await this.connect();
    const [rows] = await pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = ? AND participant_id = ?',
      [roomId, participantId],
    );
    const row = firstRow(rows);
    return row ? (row.participant_json as Participant) : null;
  }

  async putParticipant(participant: Participant): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      'INSERT INTO vidcall_participants (room_id, participant_id, participant_json) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE participant_json = VALUES(participant_json)',
      [participant.roomId, participant.participantId, JSON.stringify(participant)],
    );
  }

  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    const pool = await this.connect();
    await pool.query('DELETE FROM vidcall_participants WHERE room_id = ? AND participant_id = ?', [
      roomId,
      participantId,
    ]);
  }

  async listParticipants(roomId: string): Promise<Participant[]> {
    const pool = await this.connect();
    const [rows] = await pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = ?',
      [roomId],
    );
    return (rows as { participant_json: Participant }[])
      .map((r) => r.participant_json)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
  }

  // ---- signals -----------------------------------------------------------
  async putSignal(signal: {
    roomId: string;
    envelope: Envelope;
    receivedAt: number;
  }): Promise<StoredSignal> {
    const pool = await this.connect();
    const [result] = await pool.query(
      'INSERT INTO vidcall_signals (room_id, envelope_json, received_at) VALUES (?, ?, ?)',
      [signal.roomId, JSON.stringify(signal.envelope), signal.receivedAt],
    );
    const seq = Number((result as { insertId: number }).insertId);
    return { roomId: signal.roomId, seq, envelope: signal.envelope, receivedAt: signal.receivedAt };
  }

  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    const pool = await this.connect();
    const [rows] = await pool.query(
      'SELECT seq, envelope_json, received_at FROM vidcall_signals WHERE room_id = ? AND seq > ? ORDER BY seq',
      [roomId, since],
    );
    return (rows as { seq: number; envelope_json: Envelope; received_at: number }[]).map((r) => ({
      roomId,
      seq: Number(r.seq),
      envelope: r.envelope_json,
      receivedAt: Number(r.received_at),
    }));
  }

  // ---- recordings --------------------------------------------------------
  async putRecording(recording: RecordingSession): Promise<void> {
    const pool = await this.connect();
    await pool.query(
      'INSERT INTO vidcall_recordings (session_id, room_id, recording_json) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE recording_json = VALUES(recording_json)',
      [recording.sessionId, recording.roomId, JSON.stringify(recording)],
    );
  }

  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    const pool = await this.connect();
    const [rows] = await pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE room_id = ?',
      [roomId],
    );
    return (rows as { recording_json: RecordingSession }[]).map((r) => r.recording_json);
  }

  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    const pool = await this.connect();
    const [rows] = await pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE session_id = ?',
      [sessionId],
    );
    const row = firstRow(rows);
    return row ? (row.recording_json as RecordingSession) : null;
  }

  /** Close the underlying pool (call when shutting down). */
  async close(): Promise<void> {
    if (this.lazyPool) {
      await this.lazyPool.end();
      this.lazyPool = null;
    } else if (isPool(this.source)) {
      await this.source.end();
    }
  }
}

function firstRow(rows: unknown): Record<string, unknown> | undefined {
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

function isPool(v: unknown): v is Pool {
  return typeof v === 'object' && v !== null && 'query' in v && 'getConnection' in v;
}

/** Parse `mysql://user:pass@host:port/db` into mysql2 pool options. */
function parseConnectionUrl(url: string): PoolOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ...(u.searchParams.get('ssl') === 'true' ? { ssl: {} } : {}),
  };
}
