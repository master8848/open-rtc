/**
 * @mbsks/openrtc-server — the `Store` contract.
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
 * Implementations: `InMemoryStore` ships from the default entry; the
 * SQL-backed ones live behind subpath exports so the core stays
 * driver-free — `@mbsks/openrtc-server/stores/sqlite` (better-sqlite3),
 * `/stores/postgres` (pg), `/stores/mysql` (mysql2). See
 * `integrations/DATABASES.md` for how to implement one for any other
 * database (MongoDB, DynamoDB, Redis, Firestore, ...).
 *
 * Contract notes:
 *  - All methods are async (even in-memory) so implementations stay uniform.
 *  - `putSignal` returns the stored signal: the Store assigns the
 *    per-room monotonic `seq` atomically (identity column / MAX+1 / counter).
 *  - JSON documents round-trip verbatim (the Store must not reorder or
 *    drop fields).
 */

import type { Envelope } from '@mbsks/openrtc-protocol';
import type { BanEntry, LobbyEntry, Participant, Poll, RecordingSession, Room, StoredSignal } from './types.ts';

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
  /** Remove a room and its participants (used by closeRoom + tests). */
  deleteRoom(roomId: string): Promise<void>;

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
  deleteRecording?(sessionId: string): Promise<void>;
  listAllRecordings?(): Promise<RecordingSession[]>;

  // ---- bans (per-room) ---------------------------------------------------
  listBans?(roomId: string): Promise<BanEntry[]>;
  getBan?(roomId: string, participantId: string): Promise<BanEntry | null>;
  putBan?(roomId: string, entry: BanEntry): Promise<void>;
  deleteBan?(roomId: string, participantId: string): Promise<void>;

  // ---- lobby (waiting queue) ---------------------------------------------
  listLobby?(roomId: string): Promise<LobbyEntry[]>;
  putLobby?(roomId: string, participantId: string, enqueuedAt: number): Promise<void>;
  deleteLobby?(roomId: string, participantId: string): Promise<boolean>;

  // ---- hand queue (ordered) ----------------------------------------------
  listHandQueue?(roomId: string): Promise<string[]>;
  addHand?(roomId: string, participantId: string): Promise<void>;
  removeHand?(roomId: string, participantId: string): Promise<void>;

  // ---- polls -------------------------------------------------------------
  listPolls?(roomId: string): Promise<Poll[]>;
  getPoll?(roomId: string, pollId: string): Promise<Poll | null>;
  putPoll?(roomId: string, poll: Poll): Promise<void>;
  votePoll?(roomId: string, pollId: string, participantId: string, option: string): Promise<boolean>;
}

/** Shape a store implementation must satisfy — re-exported for convenience. */
export type StoreLike = Store;
