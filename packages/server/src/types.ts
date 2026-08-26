/**
 * @mbsks/openrtc-server — domain types.
 *
 * The server component owns ROOM/SESSION state (rooms, participants,
 * recordings) and relays signaling envelopes from `@mbsks/openrtc-protocol`
 * between room members. All types here are plain data: any framework
 * (Express, Fastify, Django, Laravel, Rails, ...) and any database can
 * host them via the function-based `Store` contract (see `store.ts`).
 */

import type { Envelope } from '@mbsks/openrtc-protocol';

/** Room lifecycle state. */
export type RoomState = 'open' | 'closed';

/** Room policy enforced by the server (secure mode). */
export interface RoomPolicy {
  /** When true, only admins/moderators may join new participants. */
  locked?: boolean;
  /** Gate recording facade (default true when undefined). */
  allowRecording?: boolean;
  /** Allowed codecs, e.g. ['VP8','H264'] (empty/undef = all). */
  allowedCodecs?: string[];
  /** Participant ids allowed to moderate (kick/mute/lock). */
  moderatorIds?: string[];
  /** When true, SFU refuses unencrypted tracks and recording is blocked or marked encrypted. */
  e2eeRequired?: boolean;
  /** Optional max participants override (mirrors Room.maxParticipants). */
  maxParticipants?: number;
}

/** A call room: durable identity + capacity + app metadata. */
export interface Room {
  /** Unique room id (client-supplied or server-generated). */
  roomId: string;
  /** Epoch ms when the room was created. */
  createdAt: number;
  /** Epoch ms of the last state-changing write (join/leave/close). */
  updatedAt: number;
  /** `open` accepts joins; `closed` rejects them (existing members keep signaling). */
  state: RoomState;
  /** Optional hard cap on concurrent participants. */
  maxParticipants?: number;
  /** App-defined metadata, round-tripped verbatim. */
  metadata?: Record<string, unknown>;
  /** Room policy (secure mode); also readable via `metadata.policy` for backwards compat. */
  policy?: RoomPolicy;
}

/** A participant currently in a room (one per senderId). */
export interface Participant {
  roomId: string;
  /** Stable peer id — matches `Envelope.senderId`. */
  participantId: string;
  /** Per-join id — matches `Envelope.sessionId`; guards stale tabs/duplicates. */
  sessionId: string;
  /** Human-readable name from the `join` payload. */
  displayName?: string;
  /** Epoch ms when the participant joined. */
  joinedAt: number;
  /** Epoch ms of the last activity (signal sent / heartbeat). */
  lastSeenAt: number;
  /** App-defined metadata (avatar URL, mute state, ...). */
  metadata?: Record<string, unknown>;
}

/** A persisted signaling envelope (the room's signal log). */
export interface StoredSignal {
  roomId: string;
  /** Monotonic per-room sequence assigned by the Store at insert time. */
  seq: number;
  /** The protocol envelope, verbatim. */
  envelope: Envelope;
  /** Epoch ms when the server persisted the signal. */
  receivedAt: number;
}

/** Recording session lifecycle state. */
export type RecordingStatus = 'recording' | 'finalized';

/** Metadata for one recording session (chunks live in `RecordingStorage`). */
export interface RecordingSession {
  /** Unique recording id (server-generated). */
  sessionId: string;
  roomId: string;
  /** Epoch ms when recording started. */
  startedAt: number;
  /** Epoch ms when the recording was stopped/finalized. */
  stoppedAt?: number;
  status: RecordingStatus;
  /** Recording mode (unified surface: client | sfu-selective | sfu-composite). */
  mode?: 'client' | 'sfu-selective' | 'sfu-composite';
  /** Media content mode: 'audio-only' vs 'audio+video' (video tracks stripped when audio-only). */
  mediaMode?: 'audio-only' | 'audio+video';
  /** Save target: 'server' (default, persisted in RecordingStorage) vs 'browser' (future local download). */
  saveTarget?: 'server' | 'browser';
  /** MIME type for the session (e.g. video/webm;codecs=vp8,opus). */
  mimeType?: string;
  /** True when this session's bytes are ciphertext (E2EE mode; key never stored). */
  encrypted?: boolean;
  /** App-supplied key id (never the key itself). */
  keyId?: string;
  /** Who started the recording (participantId). */
  startedBy?: string;
  /** Finalize manifest (chunks, bytes, finalizedAt, encrypted, keyId). */
  manifest?: import('./recording.ts').FinalizeManifest;
  /** Epoch ms when this recording expires (TTL). */
  expiresAt?: number;
  /** Transcript sidecar URL (when STT is enabled for this session). */
  transcriptUrl?: string;
  /** App-defined metadata (uploader identity, mime type, ...). */
  metadata?: Record<string, unknown>;
}

/** Outcome of relaying one envelope: who should receive it. */
export interface SignalDelivery {
  /** The stored envelope (with server-assigned seq). */
  envelope: Envelope;
  /**
   * Recipients for this envelope:
   *  - `join` / `leave` / `presence` broadcast to everyone (sender included);
   *  - peer-addressed envelopes (`targetSenderId`) go to that one member;
   *  - everything else goes to room members except the sender.
   */
  recipients: Participant[];
}

/** Outcome of a join. */
export interface JoinResult {
  room: Room;
  participant: Participant;
  /** Full participant list after joining (including the joiner). */
  participants: Participant[];
}

/** Outcome of a leave. */
export interface LeaveResult {
  room: Room;
  /** Remaining participants after the leave. */
  participants: Participant[];
  /** The relayed leave envelope + recipients, when a leave envelope was supplied. */
  delivery?: SignalDelivery;
}
