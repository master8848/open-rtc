/**
 * SQLite `Store` backed by better-sqlite3 (synchronous driver; all methods
 * are async to match the `Store` contract).
 *
 * The driver is **injected, not imported**: this module only carries
 * `import type` for better-sqlite3, so importing it never loads the native
 * addon. `better-sqlite3` is an optional peer dependency — install it next
 * to `@vidcall/server` and pass the database handle in:
 *
 * ```
 * npm i better-sqlite3
 * ```
 *
 * ```
 * import Database from 'better-sqlite3';
 * import { SqliteStore } from '@vidcall/server/stores/sqlite';
 * const store = new SqliteStore(new Database('vidcall.db'));
 * await store.bootstrap(); // CREATE TABLE IF NOT EXISTS ...
 * ```
 *
 * Schema: four tables holding JSON documents plus indexed columns for the
 * queries the contract needs (list by room, seq > since). `vidcall_rooms`
 * and `vidcall_recordings` also work for multi-process deployments as long
 * as every process uses WAL + a shared file.
 */

import type Database from 'better-sqlite3';
import type { Envelope } from '@vidcall/protocol';
import type { Store } from '../store.ts';
import type { Participant, RecordingSession, Room, StoredSignal } from '../types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vidcall_rooms (
  room_id   TEXT PRIMARY KEY,
  room_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vidcall_participants (
  room_id        TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_json TEXT NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
CREATE TABLE IF NOT EXISTS vidcall_signals (
  room_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_vidcall_signals_room ON vidcall_signals (room_id);
CREATE TABLE IF NOT EXISTS vidcall_recordings (
  session_id     TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL,
  recording_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vidcall_recordings_room ON vidcall_recordings (room_id);
`;

export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private bootstrapped = false;

  constructor(db: Database.Database) {
    if (typeof db === 'string' || db === undefined || db === null) {
      throw new Error(
        'SqliteStore expects a better-sqlite3 Database instance, not a file path. ' +
          'Install the optional peer dependency and pass the handle in: ' +
          "npm i better-sqlite3 → new SqliteStore(new Database('vidcall.db'))",
      );
    }
    this.db = db;
  }

  /** Create tables if missing. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.db.exec(SCHEMA);
    this.bootstrapped = true;
  }

  private ensure(): void {
    if (!this.bootstrapped) throw new Error('SqliteStore.bootstrap() must be called before use');
  }

  // ---- rooms -------------------------------------------------------------
  async getRoom(roomId: string): Promise<Room | null> {
    this.ensure();
    const row = this.db
      .prepare('SELECT room_json FROM vidcall_rooms WHERE room_id = ?')
      .get(roomId) as { room_json: string } | undefined;
    return row ? (JSON.parse(row.room_json) as Room) : null;
  }

  async putRoom(room: Room): Promise<void> {
    this.ensure();
    this.db
      .prepare(
        'INSERT INTO vidcall_rooms (room_id, room_json) VALUES (?, ?) ' +
          'ON CONFLICT (room_id) DO UPDATE SET room_json = excluded.room_json',
      )
      .run(room.roomId, JSON.stringify(room));
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.ensure();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM vidcall_rooms WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM vidcall_participants WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM vidcall_signals WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM vidcall_recordings WHERE room_id = ?').run(roomId);
    })();
  }

  // ---- participants ------------------------------------------------------
  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    this.ensure();
    const row = this.db
      .prepare(
        'SELECT participant_json FROM vidcall_participants WHERE room_id = ? AND participant_id = ?',
      )
      .get(roomId, participantId) as { participant_json: string } | undefined;
    return row ? (JSON.parse(row.participant_json) as Participant) : null;
  }

  async putParticipant(participant: Participant): Promise<void> {
    this.ensure();
    this.db
      .prepare(
        'INSERT INTO vidcall_participants (room_id, participant_id, participant_json) VALUES (?, ?, ?) ' +
          'ON CONFLICT (room_id, participant_id) DO UPDATE SET participant_json = excluded.participant_json',
      )
      .run(participant.roomId, participant.participantId, JSON.stringify(participant));
  }

  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    this.ensure();
    this.db
      .prepare('DELETE FROM vidcall_participants WHERE room_id = ? AND participant_id = ?')
      .run(roomId, participantId);
  }

  async listParticipants(roomId: string): Promise<Participant[]> {
    this.ensure();
    const rows = this.db
      .prepare('SELECT participant_json FROM vidcall_participants WHERE room_id = ?')
      .all(roomId) as { participant_json: string }[];
    return rows
      .map((r) => JSON.parse(r.participant_json) as Participant)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
  }

  // ---- signals -----------------------------------------------------------
  async putSignal(signal: {
    roomId: string;
    envelope: Envelope;
    receivedAt: number;
  }): Promise<StoredSignal> {
    this.ensure();
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM vidcall_signals WHERE room_id = ?')
        .get(signal.roomId) as { next: number };
      const seq = row.next;
      this.db
        .prepare(
          'INSERT INTO vidcall_signals (room_id, seq, envelope_json, received_at) VALUES (?, ?, ?, ?)',
        )
        .run(signal.roomId, seq, JSON.stringify(signal.envelope), signal.receivedAt);
      return {
        roomId: signal.roomId,
        seq,
        envelope: signal.envelope,
        receivedAt: signal.receivedAt,
      } satisfies StoredSignal;
    })();
  }

  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        'SELECT seq, envelope_json, received_at FROM vidcall_signals WHERE room_id = ? AND seq > ? ORDER BY seq',
      )
      .all(roomId, since) as { seq: number; envelope_json: string; received_at: number }[];
    return rows.map((r) => ({
      roomId,
      seq: r.seq,
      envelope: JSON.parse(r.envelope_json) as Envelope,
      receivedAt: r.received_at,
    }));
  }

  // ---- recordings --------------------------------------------------------
  async putRecording(recording: RecordingSession): Promise<void> {
    this.ensure();
    this.db
      .prepare(
        'INSERT INTO vidcall_recordings (session_id, room_id, recording_json) VALUES (?, ?, ?) ' +
          'ON CONFLICT (session_id) DO UPDATE SET recording_json = excluded.recording_json',
      )
      .run(recording.sessionId, recording.roomId, JSON.stringify(recording));
  }

  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    this.ensure();
    const rows = this.db
      .prepare('SELECT recording_json FROM vidcall_recordings WHERE room_id = ?')
      .all(roomId) as { recording_json: string }[];
    return rows.map((r) => JSON.parse(r.recording_json) as RecordingSession);
  }

  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    this.ensure();
    const row = this.db
      .prepare('SELECT recording_json FROM vidcall_recordings WHERE session_id = ?')
      .get(sessionId) as { recording_json: string } | undefined;
    return row ? (JSON.parse(row.recording_json) as RecordingSession) : null;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
