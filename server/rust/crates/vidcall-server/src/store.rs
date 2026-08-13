//! The [`Store`] contract — mirror of `packages/server/src/store.ts`.
//!
//! The server core is a set of pure functions (`core.rs`) that take a
//! `Store` as their first argument. A `Store` is a minimal KV + query
//! surface — ~10 methods — that any database can implement:
//!
//!  - rooms:            one row per room (JSON document)
//!  - participants:     one row per (room, participant)
//!  - signals:          append-only per-room log of protocol envelopes
//!  - recordings:       one row per recording session (metadata only)
//!
//! Implementations ship in `stores/`: `InMemoryStore` (tests/dev),
//! `SqliteStore` (rusqlite, bundled), `PostgresStore` (tokio-postgres),
//! `ConvexStore` (Convex HTTP actions), `SupabaseStore` (PostgREST REST CRUD)
//! and the generic `HttpJsonStore` pattern (Firebase/Appwrite/any BaaS).
//! Every implementation passes the SHARED store test suite
//! (`crate::shared_tests::run_store_test_suite`), mirroring the client-side
//! shared-adapter-suite pattern.
//!
//! Contract notes:
//!  - All methods are async (even in-memory) so implementations stay uniform.
//!  - `put_signal` returns the stored signal: the Store assigns the per-room
//!    monotonic `seq` atomically (identity column / MAX+1 / counter).
//!  - JSON documents round-trip verbatim (the Store must not reorder or drop
//!    fields).

use async_trait::async_trait;
use futures_util::Stream;

use crate::protocol::Envelope;
use crate::types::{Participant, RecordingSession, Room, StoredSignal};

/// A signal waiting to be persisted (seq is assigned by the Store).
#[derive(Debug, Clone)]
pub struct SignalInput {
    pub room_id: String,
    pub envelope: Envelope,
    /// Epoch ms when the server accepted the signal.
    pub received_at: i64,
}

/// A stream of stored signals (the change feed for a room). Boxed so
/// non-`Unpin` stream implementations (async pollers) can be returned.
pub type SignalStream = Box<dyn Stream<Item = StoredSignal> + Send>;

/// Minimal KV + query surface implemented by every backing database.
///
/// Object-safe (via `async_trait`) so a sidecar can hold
/// `Arc<dyn Store>` while library users can also keep concrete stores.
#[async_trait]
pub trait Store: Send + Sync + 'static {
    // ---- rooms -----------------------------------------------------------

    async fn get_room(&self, room_id: &str) -> crate::error::Result<Option<Room>>;

    async fn put_room(&self, room: &Room) -> crate::error::Result<()>;

    /// Remove a room and its participants (used by `close_room` + tests).
    /// Optional: the default implementation is a no-op, matching the TS
    /// `deleteRoom?` optional method.
    async fn delete_room(&self, _room_id: &str) -> crate::error::Result<()> {
        Ok(())
    }

    // ---- participants ----------------------------------------------------

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> crate::error::Result<Option<Participant>>;

    async fn put_participant(&self, participant: &Participant) -> crate::error::Result<()>;

    async fn delete_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> crate::error::Result<()>;

    async fn list_participants(&self, room_id: &str) -> crate::error::Result<Vec<Participant>>;

    // ---- signals (append-only per-room log) ------------------------------

    async fn put_signal(&self, signal: SignalInput) -> crate::error::Result<StoredSignal>;

    /// Signals with `seq > since`, ordered ascending by seq.
    async fn list_signals(&self, room_id: &str, since: i64)
        -> crate::error::Result<Vec<StoredSignal>>;

    // ---- recordings ------------------------------------------------------

    async fn put_recording(&self, recording: &RecordingSession) -> crate::error::Result<()>;

    async fn list_recordings(&self, room_id: &str) -> crate::error::Result<Vec<RecordingSession>>;

    async fn get_recording(&self, session_id: &str)
        -> crate::error::Result<Option<RecordingSession>>;

    // ---- change feed (WS relay / cross-node fan-out) ---------------------

    /// Subscribe to the room's signal change feed.
    ///
    /// Returns `None` when the store has no feed (custom stores may leave the
    /// default). In-memory/SQLite stores return an in-process broadcast;
    /// remote stores (Postgres/Convex/Supabase/HttpJson) return a polling
    /// stream over `list_signals`. The sidecar's WebSocket relay drives its
    /// in-process hub directly; `subscribe` is the cross-process mechanism —
    /// see `DATABASES.md`.
    fn subscribe(&self, _room_id: &str) -> Option<SignalStream> {
        None
    }
}
