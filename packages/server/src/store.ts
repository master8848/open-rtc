/**
 * @vidcall/server — the `Store` contract.
 *
 * The server core is a set of pure functions (`core.ts`) that take a
 * `Store` as their first argument. A `Store` is a minimal KV + query
 * surface — ~10 methods — that any database can implement:
 *
 *  - rooms:                 one row per room (JSON document)
 *  - participants:          one row per (room, participant)
 *  - signals:               append-only per-room log of protocol envelopes
 *  - recordings:            one row per recording session (metadata only)
 *
 * Implementations ship in `src/stores/`: `InMemoryStore` (tests/dev),
 * `SqliteStore` (better-sqlite3), `PostgresStore` (pg), `MysqlStore`
 * (mysql2). See `integrations/DATABASES.md` for how to implement one for
 * any other database (MongoDB, DynamoDB, Redis, Firestore, ...).
 *
 * Contract notes:
 *  - All methods are async (even in-memory) so implementations stay uniform.
 *  - `putSignal` returns the stored signal: the Store assigns the
 *    per-room monotonic `seq` atomically (identity column / MAX+1 / counter).
 *  - JSON documents round-trip verbatim (the Store must not reorder or
 *    drop fields).
 */

import type { Envelope } from '@vidcall/protocol';
import type { Participant, RecordingSession, Room, StoredSignal } from './types.js';

/** A signal waiting to be persisted (seq is assigned by the Store). */
export interface SignalInput {
  roomId: string;
  envelope: Envelope;
  /** Epoch ms when the server accepted the signal. */
  receivedAt: number;
}

/** Minimal KV + query surface implemented by every backing database. */
export interface Store {
  // ---- rooms -------------------------------------------------------------
  getRoom(roomId: string): Promise<Room | null>;
  putRoom(room: Room): Promise<void>;
  /** Optional: remove a room and its participants (used by closeRoom + tests). */
  deleteRoom?(roomId: string): Promise<void>;

  // ---- participants ------------------------------------------------------
  getParticipant(roomId: string, participantId: string): Promise<Participant | null>;
  putParticipant(participant: Participant): Promise<void>;
  deleteParticipant(roomId: string, participantId: string): Promise<void>;
  listParticipants(roomId: string): Promise<Participant[]>;

  // ---- signals (append-only per-room log) --------------------------------
  putSignal(signal: SignalInput): Promise<StoredSignal>;
  /** Signals with `seq > since`, ordered ascending by seq. */
  listSignals(roomId: string, since: number): Promise<StoredSignal[]>;

  // ---- recordings --------------------------------------------------------
  putRecording(recording: RecordingSession): Promise<void>;
  listRecordings(roomId: string): Promise<RecordingSession[]>;
  getRecording(sessionId: string): Promise<RecordingSession | null>;
}

/** Shape a store implementation must satisfy — re-exported for convenience. */
export type StoreLike = Store;
