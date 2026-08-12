/**
 * MySQL `Store` backed by `mysql2/promise`.
 *
 * Accepts a `mysql2/promise` Pool or a connection options object (or a
 * URL string). Signal seqs use a per-(room) AUTO_INCREMENT column so
 * ordering is atomic under concurrency.
 *
 * ```
 * import { MysqlStore } from '@vidcall/server';
 * const store = new MysqlStore({ host: '127.0.0.1', port: 3306, user: 'vidcall', password: '...', database: 'vidcall' });
 * await store.bootstrap();
 * ```
 */

import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import type { Envelope } from '@vidcall/protocol';
import type { Store } from '../store.js';
import type { Participant, RecordingSession, Room, StoredSignal } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vidcall_rooms (
  room_id   VARCHAR(255) PRIMARY KEY,
  room_json JSON NOT NULL
);
CREATE TABLE IF NOT EXISTS vidcall_participants (
  room_id         VARCHAR(255) NOT NULL,
  participant_id  VARCHAR(255) NOT NULL,
  participant_json JSON NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
CREATE TABLE IF NOT EXISTS vidcall_signals (
  room_id       VARCHAR(255) NOT NULL,
  seq           BIGINT NOT NULL AUTO_INCREMENT,
  envelope_json JSON NOT NULL,
  received_at   BIGINT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE TABLE IF NOT EXISTS vidcall_recordings (
  session_id     VARCHAR(255) PRIMARY KEY,
  room_id        VARCHAR(255) NOT NULL,
  recording_json JSON NOT NULL,
  INDEX idx_vidcall_recordings_room (room_id)
);
`;

export class MysqlStore implements Store {
  private readonly pool: Pool;
  private bootstrapped = false;

  constructor(poolOrOptions: Pool | PoolOptions | string) {
    if (typeof poolOrOptions === 'string') {
      this.pool = mysql.createPool(parseConnectionUrl(poolOrOptions));
    } else if (isPool(poolOrOptions)) {
      this.pool = poolOrOptions;
    } else {
      this.pool = mysql.createPool(poolOrOptions);
    }
  }

  /** Create tables if missing. Idempotent; call once at boot. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    await this.pool.query(SCHEMA);
    this.bootstrapped = true;
  }

  // ---- rooms -------------------------------------------------------------
  async getRoom(roomId: string): Promise<Room | null> {
    const [rows] = await this.pool.query('SELECT room_json FROM vidcall_rooms WHERE room_id = ?', [roomId]);
    const row = firstRow(rows);
    return row ? (row.room_json as Room) : null;
  }

  async putRoom(room: Room): Promise<void> {
    await this.pool.query(
      'INSERT INTO vidcall_rooms (room_id, room_json) VALUES (?, ?) ' +
        'ON DUPLICATE KEY UPDATE room_json = VALUES(room_json)',
      [room.roomId, JSON.stringify(room)],
    );
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.pool.query('DELETE FROM vidcall_rooms WHERE room_id = ?', [roomId]);
    await this.pool.query('DELETE FROM vidcall_participants WHERE room_id = ?', [roomId]);
    await this.pool.query('DELETE FROM vidcall_signals WHERE room_id = ?', [roomId]);
    await this.pool.query('DELETE FROM vidcall_recordings WHERE room_id = ?', [roomId]);
  }

  // ---- participants ------------------------------------------------------
  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    const [rows] = await this.pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = ? AND participant_id = ?',
      [roomId, participantId],
    );
    const row = firstRow(rows);
    return row ? (row.participant_json as Participant) : null;
  }

  async putParticipant(participant: Participant): Promise<void> {
    await this.pool.query(
      'INSERT INTO vidcall_participants (room_id, participant_id, participant_json) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE participant_json = VALUES(participant_json)',
      [participant.roomId, participant.participantId, JSON.stringify(participant)],
    );
  }

  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM vidcall_participants WHERE room_id = ? AND participant_id = ?',
      [roomId, participantId],
    );
  }

  async listParticipants(roomId: string): Promise<Participant[]> {
    const [rows] = await this.pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = ?',
      [roomId],
    );
    return (rows as { participant_json: Participant }[])
      .map((r) => r.participant_json)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
  }

  // ---- signals -----------------------------------------------------------
  async putSignal(signal: { roomId: string; envelope: Envelope; receivedAt: number }): Promise<StoredSignal> {
    const [result] = await this.pool.query(
      'INSERT INTO vidcall_signals (room_id, envelope_json, received_at) VALUES (?, ?, ?)',
      [signal.roomId, JSON.stringify(signal.envelope), signal.receivedAt],
    );
    const seq = Number((result as { insertId: number }).insertId);
    return { roomId: signal.roomId, seq, envelope: signal.envelope, receivedAt: signal.receivedAt };
  }

  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    const [rows] = await this.pool.query(
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
    await this.pool.query(
      'INSERT INTO vidcall_recordings (session_id, room_id, recording_json) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE recording_json = VALUES(recording_json)',
      [recording.sessionId, recording.roomId, JSON.stringify(recording)],
    );
  }

  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    const [rows] = await this.pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE room_id = ?',
      [roomId],
    );
    return (rows as { recording_json: RecordingSession }[]).map((r) => r.recording_json);
  }

  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    const [rows] = await this.pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE session_id = ?',
      [sessionId],
    );
    const row = firstRow(rows);
    return row ? (row.recording_json as RecordingSession) : null;
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
