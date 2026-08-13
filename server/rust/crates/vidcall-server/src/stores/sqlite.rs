//! SQLite [`Store`] backed by rusqlite (bundled, no system dependency).
//!
//! Schema: four tables holding JSON documents plus indexed columns for the
//! queries the contract needs (list by room, seq > since). `vidcall_rooms`
//! and `vidcall_recordings` also work for multi-process deployments as long
//! as every process uses WAL + a shared file.
//!
//! ```
//! use vidcall_server::stores::SqliteStore;
//! # tokio::runtime::Runtime::new().unwrap().block_on(async {
//! let store = SqliteStore::in_memory().unwrap();
//! store.bootstrap().await.unwrap();
//! # })
//! ```
//!
//! rusqlite is synchronous, so every method hops through
//! `tokio::task::spawn_blocking`; the change feed is an in-process broadcast
//! channel (same as [`InMemoryStore`](super::InMemoryStore)).

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::Stream;
use rusqlite::{params, Connection};
use tokio::sync::broadcast;

use crate::error::{Result, VidcallError};
use crate::store::{SignalInput, SignalStream, Store};
use crate::types::{Participant, RecordingSession, Room, StoredSignal};

const SCHEMA: &str = "
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
";

/// SQLite store (see module docs).
#[derive(Clone)]
pub struct SqliteStore {
    db: Arc<Mutex<Connection>>,
    feeds: Arc<Mutex<std::collections::HashMap<String, broadcast::Sender<StoredSignal>>>>,
}

/// Feed capacity for the per-room change feed.
const FEED_CAPACITY: usize = 256;

impl SqliteStore {
    /// Open a store on `path` (created when missing).
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)
            .map_err(|e| VidcallError::internal_error(format!("sqlite open failed: {e}")))?;
        Ok(Self::from_connection(conn))
    }

    /// Open an in-memory store (tests/dev).
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| VidcallError::internal_error(format!("sqlite open failed: {e}")))?;
        Ok(Self::from_connection(conn))
    }

    /// Wrap an existing connection.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            feeds: Arc::default(),
        }
    }

    /// Create tables if missing. Idempotent.
    pub async fn bootstrap(&self) -> Result<()> {
        let db = Arc::clone(&self.db);
        tokio::task::spawn_blocking(move || {
            let conn = db.lock().unwrap();
            conn.execute_batch(SCHEMA)
                .map_err(|e| VidcallError::internal_error(format!("sqlite schema failed: {e}")))
        })
        .await
        .map_err(|e| VidcallError::internal_error(format!("sqlite task failed: {e}")))??;
        Ok(())
    }
}

/// Run a synchronous rusqlite closure on the blocking pool (the connection is
/// behind a Mutex, so concurrent callers serialize on SQLite itself).
async fn with_conn<T, F>(db: &Arc<Mutex<Connection>>, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T> + Send + 'static,
{
    let db = Arc::clone(db);
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        f(&conn)
    })
    .await
    .map_err(|e| VidcallError::internal_error(format!("sqlite task failed: {e}")))?
}

#[async_trait]
impl Store for SqliteStore {
    // ---- rooms -----------------------------------------------------------

    async fn get_room(&self, room_id: &str) -> Result<Option<Room>> {
        let room_id = room_id.to_string();
        with_conn(&self.db, move |conn| {
            let row = optional_row(conn.query_row(
                "SELECT room_json FROM vidcall_rooms WHERE room_id = ?1",
                params![room_id],
                |r| r.get::<_, String>(0),
            ))?;
            row.map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|e| VidcallError::internal_error(format!("sqlite decode failed: {e}")))
        })
        .await
    }

    async fn put_room(&self, room: &Room) -> Result<()> {
        let room = room.clone();
        let json = serde_json::to_string(&room)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        with_conn(&self.db, move |conn| {
            conn.execute(
                "INSERT INTO vidcall_rooms (room_id, room_json) VALUES (?1, ?2)
                 ON CONFLICT (room_id) DO UPDATE SET room_json = excluded.room_json",
                params![room.room_id, json],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite write failed: {e}")))?;
            Ok(())
        })
        .await
    }

    async fn delete_room(&self, room_id: &str) -> Result<()> {
        let room_id = room_id.to_string();
        with_conn(&self.db, move |conn| {
            conn.execute(
                "DELETE FROM vidcall_rooms WHERE room_id = ?1",
                params![room_id],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite delete failed: {e}")))?;
            conn.execute(
                "DELETE FROM vidcall_participants WHERE room_id = ?1",
                params![room_id],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite delete failed: {e}")))?;
            conn.execute(
                "DELETE FROM vidcall_signals WHERE room_id = ?1",
                params![room_id],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite delete failed: {e}")))?;
            conn.execute(
                "DELETE FROM vidcall_recordings WHERE room_id = ?1",
                params![room_id],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite delete failed: {e}")))?;
            Ok(())
        })
        .await
    }

    // ---- participants ----------------------------------------------------

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> Result<Option<Participant>> {
        let (room_id, participant_id) = (room_id.to_string(), participant_id.to_string());
        with_conn(&self.db, move |conn| {
            let row = optional_row(conn.query_row(
                "SELECT participant_json FROM vidcall_participants
                 WHERE room_id = ?1 AND participant_id = ?2",
                params![room_id, participant_id],
                |r| r.get::<_, String>(0),
            ))?;
            row.map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|e| VidcallError::internal_error(format!("sqlite decode failed: {e}")))
        })
        .await
    }

    async fn put_participant(&self, participant: &Participant) -> Result<()> {
        let participant = participant.clone();
        let json = serde_json::to_string(&participant)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        with_conn(&self.db, move |conn| {
            conn.execute(
                "INSERT INTO vidcall_participants (room_id, participant_id, participant_json)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT (room_id, participant_id)
                 DO UPDATE SET participant_json = excluded.participant_json",
                params![participant.room_id, participant.participant_id, json],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite write failed: {e}")))?;
            Ok(())
        })
        .await
    }

    async fn delete_participant(&self, room_id: &str, participant_id: &str) -> Result<()> {
        let (room_id, participant_id) = (room_id.to_string(), participant_id.to_string());
        with_conn(&self.db, move |conn| {
            conn.execute(
                "DELETE FROM vidcall_participants WHERE room_id = ?1 AND participant_id = ?2",
                params![room_id, participant_id],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite delete failed: {e}")))?;
            Ok(())
        })
        .await
    }

    async fn list_participants(&self, room_id: &str) -> Result<Vec<Participant>> {
        let room_id = room_id.to_string();
        with_conn(&self.db, move |conn| {
            let mut stmt = conn
                .prepare("SELECT participant_json FROM vidcall_participants WHERE room_id = ?1")
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            let rows = stmt
                .query_map(params![room_id], |r| r.get::<_, String>(0))
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            let mut out: Vec<Participant> = Vec::new();
            for row in rows {
                let json = row.map_err(|e| {
                    VidcallError::internal_error(format!("sqlite read failed: {e}"))
                })?;
                let p: Participant = serde_json::from_str(&json).map_err(|e| {
                    VidcallError::internal_error(format!("sqlite decode failed: {e}"))
                })?;
                out.push(p);
            }
            out.sort_by(|a, b| {
                a.joined_at
                    .cmp(&b.joined_at)
                    .then_with(|| a.participant_id.cmp(&b.participant_id))
            });
            Ok(out)
        })
        .await
    }

    // ---- signals ---------------------------------------------------------

    async fn put_signal(&self, signal: SignalInput) -> Result<StoredSignal> {
        let room_id = signal.room_id.clone();
        let envelope_json = serde_json::to_string(&signal.envelope)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let received_at = signal.received_at;
        let stored = with_conn(&self.db, move |conn| {
            let seq = conn
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM vidcall_signals WHERE room_id = ?1",
                    params![room_id],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            conn.execute(
                "INSERT INTO vidcall_signals (room_id, seq, envelope_json, received_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![room_id, seq, envelope_json, received_at],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite write failed: {e}")))?;
            Ok(StoredSignal {
                room_id,
                seq,
                envelope: signal.envelope,
                received_at,
            })
        })
        .await?;
        if let Some(tx) = self.feeds.lock().unwrap().get(&stored.room_id) {
            let _ = tx.send(stored.clone());
        }
        Ok(stored)
    }

    async fn list_signals(&self, room_id: &str, since: i64) -> Result<Vec<StoredSignal>> {
        let room_id = room_id.to_string();
        with_conn(&self.db, move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT seq, envelope_json, received_at FROM vidcall_signals
                     WHERE room_id = ?1 AND seq > ?2 ORDER BY seq",
                )
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            let rows = stmt
                .query_map(params![room_id, since], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            let mut out = Vec::new();
            for row in rows {
                let (seq, json, received_at) = row.map_err(|e| {
                    VidcallError::internal_error(format!("sqlite read failed: {e}"))
                })?;
                let envelope = serde_json::from_str(&json).map_err(|e| {
                    VidcallError::internal_error(format!("sqlite decode failed: {e}"))
                })?;
                out.push(StoredSignal {
                    room_id: room_id.clone(),
                    seq,
                    envelope,
                    received_at,
                });
            }
            Ok(out)
        })
        .await
    }

    // ---- recordings ------------------------------------------------------

    async fn put_recording(&self, recording: &RecordingSession) -> Result<()> {
        let recording = recording.clone();
        let json = serde_json::to_string(&recording)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        with_conn(&self.db, move |conn| {
            conn.execute(
                "INSERT INTO vidcall_recordings (session_id, room_id, recording_json)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT (session_id) DO UPDATE SET recording_json = excluded.recording_json",
                params![recording.session_id, recording.room_id, json],
            )
            .map_err(|e| VidcallError::internal_error(format!("sqlite write failed: {e}")))?;
            Ok(())
        })
        .await
    }

    async fn list_recordings(&self, room_id: &str) -> Result<Vec<RecordingSession>> {
        let room_id = room_id.to_string();
        with_conn(&self.db, move |conn| {
            let mut stmt = conn
                .prepare("SELECT recording_json FROM vidcall_recordings WHERE room_id = ?1")
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            let rows = stmt
                .query_map(params![room_id], |r| r.get::<_, String>(0))
                .map_err(|e| VidcallError::internal_error(format!("sqlite read failed: {e}")))?;
            let mut out = Vec::new();
            for row in rows {
                let json = row.map_err(|e| {
                    VidcallError::internal_error(format!("sqlite read failed: {e}"))
                })?;
                let r: RecordingSession = serde_json::from_str(&json).map_err(|e| {
                    VidcallError::internal_error(format!("sqlite decode failed: {e}"))
                })?;
                out.push(r);
            }
            Ok(out)
        })
        .await
    }

    async fn get_recording(&self, session_id: &str) -> Result<Option<RecordingSession>> {
        let session_id = session_id.to_string();
        with_conn(&self.db, move |conn| {
            let row = optional_row(conn.query_row(
                "SELECT recording_json FROM vidcall_recordings WHERE session_id = ?1",
                params![session_id],
                |r| r.get::<_, String>(0),
            ))?;
            row.map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|e| VidcallError::internal_error(format!("sqlite decode failed: {e}")))
        })
        .await
    }

    // ---- change feed -----------------------------------------------------

    fn subscribe(&self, room_id: &str) -> Option<SignalStream> {
        let mut feeds = self.feeds.lock().unwrap();
        let tx = feeds
            .entry(room_id.to_string())
            .or_insert_with(|| broadcast::channel(FEED_CAPACITY).0)
            .clone();
        let rx = tx.subscribe();
        Some(Box::new(broadcast_stream(rx)))
    }
}

/// Small helper: turn a `broadcast::Receiver` into a stream (ends on close,
/// skips lagged signals).
fn broadcast_stream(
    rx: broadcast::Receiver<StoredSignal>,
) -> impl Stream<Item = StoredSignal> + Send {
    // The receiver is carried in the unfold state so the FnMut closure never
    // captures it by move (the async block owns the state each step).
    futures_util::stream::unfold(Some(rx), |state| async move {
        let mut rx = state?;
        loop {
            match rx.recv().await {
                Ok(signal) => return Some((signal, Some(rx))),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

/// rusqlite `query_row` → crate `Result<Option<String>>`.
fn optional_row(result: Result<String, rusqlite::Error>) -> Result<Option<String>> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(VidcallError::internal_error(format!(
            "sqlite read failed: {e}"
        ))),
    }
}
