//! Core room/session/recording logic — mirror of `packages/server/src/core.ts`.
//!
//! Pure functions: no framework imports, no WebSocket imports, no database
//! imports. Every function takes a [`Store`] as its first argument, so the
//! same logic runs on SQLite, Postgres, Convex, Supabase, any BaaS — and is
//! hosted by axum (this crate), Express/Fastify (the TS sibling), or a
//! Django/Laravel/Rails reverse proxy.
//!
//! The core owns:
//!  - room lifecycle  (create / join / leave / close / state)
//!  - participant roster (who is in a room)
//!  - signal relay   (persist + compute recipients per protocol envelope)
//!  - recording sessions (metadata only; bytes live in `RecordingStorage`)


use crate::error::{Result, VidcallError};
use crate::protocol::{create_envelope, now_ms, Envelope};
use crate::store::Store;
use crate::types::{
    JoinResult, LeaveResult, Participant, RecordingSession, RecordingStatus, Room, RoomSnapshot,
    RoomState, SignalDelivery, StoredSignal,
};

/// Input for [`join_room`] — everything except server-assigned timestamps.
#[derive(Debug, Clone, Default)]
pub struct ParticipantInput {
    pub participant_id: String,
    pub session_id: String,
    pub display_name: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

/// Options for [`create_room`].
#[derive(Debug, Clone, Default)]
pub struct CreateRoomOptions {
    /// Explicit room id; the server generates a short id when omitted.
    pub room_id: Option<String>,
    pub max_participants: Option<u32>,
    pub metadata: Option<serde_json::Value>,
    /// Clock override (tests).
    pub now: Option<i64>,
}

/// Options for [`join_room`].
#[derive(Debug, Clone, Default)]
pub struct JoinRoomOptions {
    /// Clock override (tests).
    pub now: Option<i64>,
    /// When true, re-joining replaces the existing participant record (idempotent).
    pub upsert: bool,
}

/// Options for [`leave_room`].
#[derive(Debug, Clone, Default)]
pub struct LeaveRoomOptions {
    /// Clock override (tests).
    pub now: Option<i64>,
    /// A `leave` envelope to persist + relay to remaining members. The WS
    /// relay passes the client's own leave envelope here; REST callers may
    /// omit it (no broadcast happens).
    pub envelope: Option<Envelope>,
}

/// Options for [`start_recording`].
#[derive(Debug, Clone, Default)]
pub struct StartRecordingOptions {
    /// Explicit session id; the server generates one when omitted.
    pub session_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
    /// Clock override (tests).
    pub now: Option<i64>,
}

/// Options for [`stop_recording`].
#[derive(Debug, Clone, Default)]
pub struct StopRecordingOptions {
    /// Clock override (tests).
    pub now: Option<i64>,
}

/// Short, URL-safe, collision-resistant id (base36 of 128 random bits) —
/// mirrors the TS `randomId()`.
pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    let mut s = String::with_capacity(32);
    for b in bytes {
        // base36 of the byte, zero-padded to 2 chars — same as TS padStart(2)
        s.push_str(&format!("{:02}", b % 36));
    }
    s
}

fn clock(now: Option<i64>) -> i64 {
    now.unwrap_or_else(now_ms)
}

async fn require_room<S: Store + ?Sized>(store: &S, room_id: &str) -> Result<Room> {
    store
        .get_room(room_id)
        .await?
        .ok_or_else(|| VidcallError::room_not_found(room_id))
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/// Create a room. Fails with `room_already_exists` when the id is taken.
pub async fn create_room<S: Store + ?Sized>(
    store: &S,
    opts: CreateRoomOptions,
) -> Result<Room> {
    let room_id = opts
        .room_id
        .unwrap_or_else(random_id);
    if store.get_room(&room_id).await?.is_some() {
        return Err(VidcallError::room_already_exists(&room_id));
    }
    let t = clock(opts.now);
    let room = Room {
        room_id,
        created_at: t,
        updated_at: t,
        state: RoomState::Open,
        max_participants: opts.max_participants,
        metadata: opts.metadata,
    };
    store.put_room(&room).await?;
    Ok(room)
}

/// Fetch a room. Throws `room_not_found` for unknown ids.
pub async fn get_room<S: Store + ?Sized>(store: &S, room_id: &str) -> Result<Room> {
    require_room(store, room_id).await
}

/// Close a room: rejects future joins but keeps existing members signaling.
/// Returns the updated room.
pub async fn close_room<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
    opts: crate::core::CloseRoomOptions,
) -> Result<Room> {
    let room = require_room(store, room_id).await?;
    let updated = Room {
        state: RoomState::Closed,
        updated_at: clock(opts.now),
        ..room.clone()
    };
    store.put_room(&updated).await?;
    Ok(updated)
}

/// Options for [`close_room`].
#[derive(Debug, Clone, Default)]
pub struct CloseRoomOptions {
    /// Clock override (tests).
    pub now: Option<i64>,
}

/// Add a participant to a room. Enforces room existence + open state +
/// capacity, then returns the full roster.
pub async fn join_room<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
    input: ParticipantInput,
    opts: JoinRoomOptions,
) -> Result<JoinResult> {
    let room = require_room(store, room_id).await?;
    if room.state == RoomState::Closed {
        return Err(VidcallError::room_closed(room_id));
    }

    let existing = store.get_participant(room_id, &input.participant_id).await?;
    if existing.is_some() && !opts.upsert {
        return Err(VidcallError::participant_already_joined(
            room_id,
            &input.participant_id,
        ));
    }
    if existing.is_none() {
        if let Some(max) = room.max_participants {
            let members = store.list_participants(room_id).await?;
            if members.len() as u32 >= max {
                return Err(VidcallError::room_full(room_id));
            }
        }
    }

    let t = clock(opts.now);
    let participant = Participant {
        room_id: room_id.to_string(),
        participant_id: input.participant_id,
        session_id: input.session_id,
        display_name: input.display_name,
        joined_at: existing.as_ref().map(|e| e.joined_at).unwrap_or(t),
        last_seen_at: t,
        metadata: input.metadata,
    };
    store.put_participant(&participant).await?;
    store
        .put_room(&Room {
            updated_at: t,
            ..room.clone()
        })
        .await?;
    Ok(JoinResult {
        room,
        participant,
        participants: store.list_participants(room_id).await?,
    })
}

/// Remove a participant from a room. When `opts.envelope` (a `leave`
/// envelope) is supplied it is persisted and `delivery` describes who
/// should receive it (remaining members).
pub async fn leave_room<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
    participant_id: &str,
    opts: LeaveRoomOptions,
) -> Result<LeaveResult> {
    let room = require_room(store, room_id).await?;
    let existing = store.get_participant(room_id, participant_id).await?;
    if existing.is_none() {
        return Err(VidcallError::participant_not_found(room_id, participant_id));
    }

    let t = clock(opts.now);
    store.delete_participant(room_id, participant_id).await?;
    store
        .put_room(&Room {
            updated_at: t,
            ..room.clone()
        })
        .await?;

    let delivery = match opts.envelope {
        Some(envelope) => {
            let stored = store
                .put_signal(crate::store::SignalInput {
                    room_id: room_id.to_string(),
                    envelope,
                    received_at: t,
                })
                .await?;
            Some(SignalDelivery {
                envelope: stored.envelope,
                recipients: store.list_participants(room_id).await?,
            })
        }
        None => None,
    };
    Ok(LeaveResult {
        room,
        participants: store.list_participants(room_id).await?,
        delivery,
    })
}

// ---------------------------------------------------------------------------
// State + roster
// ---------------------------------------------------------------------------

/// Snapshot of a room: room record + participant roster + signal count.
pub async fn get_room_state<S: Store + ?Sized>(store: &S, room_id: &str) -> Result<RoomSnapshot> {
    let room = require_room(store, room_id).await?;
    let participants = store.list_participants(room_id).await?;
    let signals = store.list_signals(room_id, 0).await?;
    Ok(RoomSnapshot {
        room,
        participants,
        signal_count: signals.len() as u64,
    })
}

/// Participant roster for a room. Throws `room_not_found` for unknown rooms.
pub async fn list_participants<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
) -> Result<Vec<Participant>> {
    require_room(store, room_id).await?;
    store.list_participants(room_id).await
}

/// Signal log for a room, `seq > since`, ascending.
pub async fn list_signals<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
    since: i64,
) -> Result<Vec<StoredSignal>> {
    require_room(store, room_id).await?;
    store.list_signals(room_id, since).await
}

// ---------------------------------------------------------------------------
// Signal relay
// ---------------------------------------------------------------------------

/// Relay one protocol envelope: validates it, persists it to the room's
/// signal log, and computes the recipient set.
///
/// Recipient rules (mirror the client engine's expectations):
///  - `join` / `leave` / `presence`  → everyone (sender included)
///  - envelope with `target_sender_id` → that member only
///  - anything else (`offer`/`answer`/`ice`/`reaction`/`chat`/...) →
///    room members except the sender
///
/// Throws `invalid_envelope` for malformed envelopes, `room_not_found` for
/// unknown rooms, and `participant_not_found` when a non-`join` envelope
/// arrives from a sender that is not in the room.
pub async fn handle_signal<S: Store + ?Sized>(
    store: &S,
    envelope_value: serde_json::Value,
) -> Result<SignalDelivery> {
    if !crate::protocol::is_envelope(&envelope_value) {
        return Err(VidcallError::invalid_envelope(
            "Envelope failed protocol validation (see protocol/schema.json)",
        ));
    }
    let envelope = crate::protocol::envelope_from_value(envelope_value)
        .ok_or_else(|| VidcallError::invalid_envelope("Envelope failed protocol validation"))?;
    handle_signal_envelope(store, envelope).await
}

/// Relay a pre-validated envelope (used by the WS relay).
pub async fn handle_signal_envelope<S: Store + ?Sized>(
    store: &S,
    envelope: Envelope,
) -> Result<SignalDelivery> {
    let room = require_room(store, &envelope.room_id).await?;
    let _ = room;
    let t = now_ms();

    if envelope.r#type != "join" {
        let participant = store
            .get_participant(&envelope.room_id, &envelope.sender_id)
            .await?;
        let participant = participant.ok_or_else(|| {
            VidcallError::participant_not_found(&envelope.room_id, &envelope.sender_id)
        })?;
        // Closed rooms keep existing members signaling; only new joins are rejected.
        if envelope.r#type != "leave" {
            store
                .put_participant(&Participant {
                    last_seen_at: t,
                    ..participant
                })
                .await?;
        }
    }

    let stored = store
        .put_signal(crate::store::SignalInput {
            room_id: envelope.room_id.clone(),
            envelope,
            received_at: t,
        })
        .await?;
    let members = store.list_participants(&stored.envelope.room_id).await?;

    let recipients = if matches!(
        stored.envelope.r#type.as_str(),
        "join" | "leave" | "presence"
    ) {
        members
    } else if let Some(target) = &stored.envelope.target_sender_id {
        members
            .into_iter()
            .filter(|m| &m.participant_id == target)
            .collect()
    } else {
        members
            .into_iter()
            .filter(|m| m.participant_id != stored.envelope.sender_id)
            .collect()
    };

    Ok(SignalDelivery {
        envelope: stored.envelope,
        recipients,
    })
}

// ---------------------------------------------------------------------------
// Recording sessions (metadata only; bytes go to RecordingStorage)
// ---------------------------------------------------------------------------

/// Start a recording session for a room. Only metadata is stored here; the
/// media chunks are handed to a `RecordingStorage` by the hosting layer.
pub async fn start_recording<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
    opts: StartRecordingOptions,
) -> Result<RecordingSession> {
    require_room(store, room_id).await?;
    let session_id = opts.session_id.unwrap_or_else(random_id);
    let recording = RecordingSession {
        session_id,
        room_id: room_id.to_string(),
        started_at: clock(opts.now),
        status: RecordingStatus::Recording,
        stopped_at: None,
        metadata: opts.metadata,
    };
    store.put_recording(&recording).await?;
    Ok(recording)
}

/// Stop a recording session and mark it `finalized`. Throws
/// `recording_not_found` for unknown sessions.
pub async fn stop_recording<S: Store + ?Sized>(
    store: &S,
    session_id: &str,
    opts: StopRecordingOptions,
) -> Result<RecordingSession> {
    let current = get_recording(store, session_id).await?;
    let stopped = RecordingSession {
        stopped_at: Some(clock(opts.now)),
        status: RecordingStatus::Finalized,
        ..current
    };
    store.put_recording(&stopped).await?;
    Ok(stopped)
}

/// Fetch one recording session (throws `recording_not_found`).
pub async fn get_recording<S: Store + ?Sized>(
    store: &S,
    session_id: &str,
) -> Result<RecordingSession> {
    store
        .get_recording(session_id)
        .await?
        .ok_or_else(|| VidcallError::recording_not_found(session_id))
}

/// All recording sessions for a room, newest first.
pub async fn get_recordings<S: Store + ?Sized>(
    store: &S,
    room_id: &str,
) -> Result<Vec<RecordingSession>> {
    require_room(store, room_id).await?;
    let mut all = store.list_recordings(room_id).await?;
    all.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(all)
}

/// Build the protocol `join` envelope for a participant (relay helper).
pub fn build_join_envelope(room_id: &str, input: &ParticipantInput) -> Envelope {
    let payload = serde_json::json!({
        "displayName": input.display_name,
        "metadata": input.metadata,
    });
    let payload = match payload {
        serde_json::Value::Object(mut m) => {
            m.remove("displayName");
            m.remove("metadata");
            let mut out = serde_json::Map::new();
            if let Some(d) = &input.display_name {
                out.insert("displayName".into(), serde_json::Value::String(d.clone()));
            }
            if let Some(md) = &input.metadata {
                out.insert("metadata".into(), md.clone());
            }
            Some(serde_json::Value::Object(out))
        }
        _ => None,
    };
    create_envelope("join", room_id, &input.participant_id, &input.session_id, payload)
}

/// Build the protocol `leave` envelope for a participant (relay helper).
pub fn build_leave_envelope(room_id: &str, participant: &Participant, reason: Option<&str>) -> Envelope {
    let payload = reason.map(|r| serde_json::json!({ "reason": r }));
    create_envelope(
        "leave",
        room_id,
        &participant.participant_id,
        &participant.session_id,
        payload,
    )
}
