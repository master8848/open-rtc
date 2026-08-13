//! Domain types — mirror of `packages/server/src/types.ts`.
//!
//! The server component owns ROOM/SESSION state (rooms, participants,
//! recordings) and relays signaling envelopes between room members. All types
//! are plain data: any framework and any database can host them via the
//! function-based [`Store`](crate::store::Store) contract.

use serde::{Deserialize, Serialize};

use crate::protocol::Envelope;

/// Room lifecycle state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomState {
    /// Accepts joins.
    #[default]
    Open,
    /// Rejects new joins; existing members keep signaling.
    Closed,
}

/// A call room: durable identity + capacity + app metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    /// Unique room id (client-supplied or server-generated).
    pub room_id: String,
    /// Epoch ms when the room was created.
    pub created_at: i64,
    /// Epoch ms of the last state-changing write (join/leave/close).
    pub updated_at: i64,
    /// `open` accepts joins; `closed` rejects them (existing members keep signaling).
    #[serde(default)]
    pub state: RoomState,
    /// Optional hard cap on concurrent participants.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_participants: Option<u32>,
    /// App-defined metadata, round-tripped verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// A participant currently in a room (one per senderId).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub room_id: String,
    /// Stable peer id — matches `Envelope.sender_id`.
    pub participant_id: String,
    /// Per-join id — matches `Envelope.session_id`; guards stale tabs/duplicates.
    pub session_id: String,
    /// Human-readable name from the `join` payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Epoch ms when the participant joined.
    pub joined_at: i64,
    /// Epoch ms of the last activity (signal sent / heartbeat).
    pub last_seen_at: i64,
    /// App-defined metadata (avatar URL, mute state, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// A persisted signaling envelope (the room's signal log).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSignal {
    pub room_id: String,
    /// Monotonic per-room sequence assigned by the Store at insert time.
    pub seq: i64,
    /// The protocol envelope, verbatim.
    pub envelope: Envelope,
    /// Epoch ms when the server persisted the signal.
    pub received_at: i64,
}

/// Recording session lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingStatus {
    Recording,
    Finalized,
}

/// Metadata for one recording session (chunks live in `RecordingStorage`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSession {
    /// Unique recording id (server-generated).
    pub session_id: String,
    pub room_id: String,
    /// Epoch ms when recording started.
    pub started_at: i64,
    /// Epoch ms when the recording was stopped/finalized.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<i64>,
    pub status: RecordingStatus,
    /// App-defined metadata (uploader identity, mime type, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Outcome of relaying one envelope: who should receive it.
#[derive(Debug, Clone)]
pub struct SignalDelivery {
    /// The stored envelope (with server-assigned seq).
    pub envelope: Envelope,
    /// Recipients for this envelope:
    ///  - `join` / `leave` / `presence` broadcast to everyone (sender included);
    ///  - peer-addressed envelopes (`target_sender_id`) go to that one member;
    ///  - everything else goes to room members except the sender.
    pub recipients: Vec<Participant>,
}

/// Outcome of a join.
#[derive(Debug, Clone)]
pub struct JoinResult {
    pub room: Room,
    pub participant: Participant,
    /// Full participant list after joining (including the joiner).
    pub participants: Vec<Participant>,
}

/// Outcome of a leave.
#[derive(Debug, Clone)]
pub struct LeaveResult {
    pub room: Room,
    /// Remaining participants after the leave.
    pub participants: Vec<Participant>,
    /// The relayed leave envelope + recipients, when a leave envelope was supplied.
    pub delivery: Option<SignalDelivery>,
}

/// Snapshot of a room: room record + participant roster + signal count.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub room: Room,
    pub participants: Vec<Participant>,
    /// Signals persisted for this room so far (server-assigned seqs).
    pub signal_count: u64,
}
