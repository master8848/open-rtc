/**
 * PostgreSQL `Store` backed by `pg`.
 *
 * Accepts a `pg.Pool`, a `pg.Client`, or a connection string. Tables are
 * JSON documents + indexed columns; signal seqs come from a `BIGINT
 * GENERATED ALWAYS AS IDENTITY` column so per-room ordering is atomic even
 * under concurrency.
 *
 * ```
 * import { PostgresStore } from '@vidcall/server';
 * const store = new PostgresStore('postgres://user:pass@localhost/vidcall');
 * await store.bootstrap();
 * ```
 *
 * For real-time push (LISTEN/NOTIFY + a WebSocket bridge) see the
 * `backend-postgres` adapter; this store is the durable state + REST/WS
 * relay substrate.
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { Envelope } from '@vidcall/protocol';
import type { Store } from '../store.js';
import type { Participant, RecordingSession, Room, StoredSignal } from '../types.js';

const { Pool: PgPool } = pg;

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
`;

type Queryable = Pick<Pool | PoolClient, 'query'>;

export class PostgresStore implements Store {
  private readonly pool: Queryable;
  private bootstrapped = false;

  constructor(poolOrConnectionString: Queryable | string) {
    if (typeof poolOrConnectionString === 'string') {
      this.pool = new PgPool({ connectionString: poolOrConnectionString });
    } else {
      this.pool = poolOrConnectionString;
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
    const { rows } = await this.pool.query('SELECT room_json FROM vidcall_rooms WHERE room_id = $1', [roomId]);
    return rows[0] ? (rows[0].room_json as Room) : null;
  }

  async putRoom(room: Room): Promise<void> {
    await this.pool.query(
      `INSERT INTO vidcall_rooms (room_id, room_json) VALUES ($1, $2)
       ON CONFLICT (room_id) DO UPDATE SET room_json = EXCLUDED.room_json`,
      [room.roomId, JSON.stringify(room)],
    );
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.pool.query('DELETE FROM vidcall_rooms WHERE room_id = $1', [roomId]);
    await this.pool.query('DELETE FROM vidcall_participants WHERE room_id = $1', [roomId]);
    await this.pool.query('DELETE FROM vidcall_signals WHERE room_id = $1', [roomId]);
    await this.pool.query('DELETE FROM vidcall_recordings WHERE room_id = $1', [roomId]);
  }

  // ---- participants ------------------------------------------------------
  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    const { rows } = await this.pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = $1 AND participant_id = $2',
      [roomId, participantId],
    );
    return rows[0] ? (rows[0].participant_json as Participant) : null;
  }

  async putParticipant(participant: Participant): Promise<void> {
    await this.pool.query(
      `INSERT INTO vidcall_participants (room_id, participant_id, participant_json) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, participant_id) DO UPDATE SET participant_json = EXCLUDED.participant_json`,
      [participant.roomId, participant.participantId, JSON.stringify(participant)],
    );
  }

  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM vidcall_participants WHERE room_id = $1 AND participant_id = $2',
      [roomId, participantId],
    );
  }

  async listParticipants(roomId: string): Promise<Participant[]> {
    const { rows } = await this.pool.query(
      'SELECT participant_json FROM vidcall_participants WHERE room_id = $1',
      [roomId],
    );
    return (rows.map((r) => r.participant_json as Participant) as Participant[]).sort(
      (a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId),
    );
  }

  // ---- signals -----------------------------------------------------------
  async putSignal(signal: { roomId: string; envelope: Envelope; receivedAt: number }): Promise<StoredSignal> {
    const { rows } = await this.pool.query(
      `INSERT INTO vidcall_signals (room_id, envelope_json, received_at) VALUES ($1, $2, $3)
       RETURNING seq`,
      [signal.roomId, JSON.stringify(signal.envelope), signal.receivedAt],
    );
    const seq = Number(rows[0]!.seq);
    return { roomId: signal.roomId, seq, envelope: signal.envelope, receivedAt: signal.receivedAt };
  }

  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    const { rows } = await this.pool.query(
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
    await this.pool.query(
      `INSERT INTO vidcall_recordings (session_id, room_id, recording_json) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET recording_json = EXCLUDED.recording_json`,
      [recording.sessionId, recording.roomId, JSON.stringify(recording)],
    );
  }

  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    const { rows } = await this.pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE room_id = $1',
      [roomId],
    );
    return rows.map((r) => r.recording_json as RecordingSession);
  }

  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    const { rows } = await this.pool.query(
      'SELECT recording_json FROM vidcall_recordings WHERE session_id = $1',
      [sessionId],
    );
    return rows[0] ? (rows[0].recording_json as RecordingSession) : null;
  }
}
