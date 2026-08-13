//! PostgreSQL [`Store`] backed by tokio-postgres (the smallest Rust pg
//! driver that fits; sqlx was deliberately not chosen — heavier, and we only
//! need prepared queries over one connection).
//!
//! Tables are JSON documents + indexed columns; signal seqs come from a
//! `BIGINT GENERATED ALWAYS AS IDENTITY` column so per-room ordering is
//! atomic even under concurrency (mirrors `packages/server`'s PostgresStore).
//!
//! ```no_run
//! use vidcall_server::stores::PostgresStore;
//! # async fn example() {
//! let store = PostgresStore::connect("postgres://user:pass@localhost/vidcall")
//!     .await
//!     .unwrap();
//! store.bootstrap().await.unwrap();
//! # }
//! ```
//!
//! One dedicated connection is used (the sidecar pattern: tiny + predictable).

use std::time::Duration;

use async_trait::async_trait;
use tokio_postgres::{Client, NoTls};

use crate::error::{Result, VidcallError};
use crate::store::{SignalInput, SignalStream, Store};
use crate::types::{Participant, RecordingSession, Room, StoredSignal};

const SCHEMA: &str = "
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
";

/// PostgreSQL store (see module docs).
pub struct PostgresStore {
    client: std::sync::Arc<tokio::sync::Mutex<Client>>,
    poll_interval: Duration,
}

impl PostgresStore {
    /// Connect to a Postgres server from a connection string
    /// (`postgres://user:pass@host:5432/db`).
    pub async fn connect(connection_string: &str) -> Result<Self> {
        let (client, connection) = tokio_postgres::connect(connection_string, NoTls)
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres connect failed: {e}")))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::warn!(error = %e, "postgres connection closed");
            }
        });
        Ok(Self::new(client))
    }

    /// Connect with rustls TLS (`sslmode=require|verify-full` in the URL is
    /// honored). Ena

    /// Wrap an existing connected client (tests).
    pub fn new(client: Client) -> Self {
        Self {
            client: std::sync::Arc::new(tokio::sync::Mutex::new(client)),
            poll_interval: Duration::from_millis(100),
        }
    }

    /// Change-feed polling interval (default 100 ms).
    pub fn with_poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    /// Create tables if missing. Idempotent; call once at boot.
    pub async fn bootstrap(&self) -> Result<()> {
        let client = self.client.lock().await;
        client
            .batch_execute(SCHEMA)
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres schema failed: {e}")))?;
        Ok(())
    }
}

#[async_trait]
impl Store for PostgresStore {
    // ---- rooms -----------------------------------------------------------

    async fn get_room(&self, room_id: &str) -> Result<Option<Room>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT room_json FROM vidcall_rooms WHERE room_id = $1",
                &[&room_id],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres query failed: {e}")))?;
        rows.first()
            .map(|r| serde_json::from_value(r.get::<_, serde_json::Value>(0)))
            .transpose()
            .map_err(|e| VidcallError::internal_error(format!("postgres decode failed: {e}")))
    }

    async fn put_room(&self, room: &Room) -> Result<()> {
        let room = room.clone();
        let json = serde_json::to_value(&room)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let client = self.client.lock().await;
        client
            .execute(
                "INSERT INTO vidcall_rooms (room_id, room_json) VALUES ($1, $2)
                 ON CONFLICT (room_id) DO UPDATE SET room_json = EXCLUDED.room_json",
                &[&room.room_id, &json],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres write failed: {e}")))?;
        Ok(())
    }

    async fn delete_room(&self, room_id: &str) -> Result<()> {
        let client = self.client.lock().await;
        for table in [
            "vidcall_rooms",
            "vidcall_participants",
            "vidcall_signals",
            "vidcall_recordings",
        ] {
            let sql = format!("DELETE FROM {table} WHERE room_id = $1");
            client.execute(&sql, &[&room_id]).await.map_err(|e| {
                VidcallError::internal_error(format!("postgres delete failed: {e}"))
            })?;
        }
        Ok(())
    }

    // ---- participants ----------------------------------------------------

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> Result<Option<Participant>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT participant_json FROM vidcall_participants WHERE room_id = $1 AND participant_id = $2",
                &[&room_id, &participant_id],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres query failed: {e}")))?;
        rows.first()
            .map(|r| serde_json::from_value(r.get::<_, serde_json::Value>(0)))
            .transpose()
            .map_err(|e| VidcallError::internal_error(format!("postgres decode failed: {e}")))
    }

    async fn put_participant(&self, participant: &Participant) -> Result<()> {
        let participant = participant.clone();
        let json = serde_json::to_value(&participant)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let client = self.client.lock().await;
        client
            .execute(
                "INSERT INTO vidcall_participants (room_id, participant_id, participant_json)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (room_id, participant_id)
                 DO UPDATE SET participant_json = EXCLUDED.participant_json",
                &[&participant.room_id, &participant.participant_id, &json],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres write failed: {e}")))?;
        Ok(())
    }

    async fn delete_participant(&self, room_id: &str, participant_id: &str) -> Result<()> {
        let client = self.client.lock().await;
        client
            .execute(
                "DELETE FROM vidcall_participants WHERE room_id = $1 AND participant_id = $2",
                &[&room_id, &participant_id],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres delete failed: {e}")))?;
        Ok(())
    }

    async fn list_participants(&self, room_id: &str) -> Result<Vec<Participant>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT participant_json FROM vidcall_participants WHERE room_id = $1",
                &[&room_id],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres query failed: {e}")))?;
        let mut out: Vec<Participant> = rows
            .iter()
            .map(|r| serde_json::from_value(r.get::<_, serde_json::Value>(0)))
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| VidcallError::internal_error(format!("postgres decode failed: {e}")))?;
        out.sort_by(|a, b| {
            a.joined_at
                .cmp(&b.joined_at)
                .then_with(|| a.participant_id.cmp(&b.participant_id))
        });
        Ok(out)
    }

    // ---- signals ---------------------------------------------------------

    async fn put_signal(&self, signal: SignalInput) -> Result<StoredSignal> {
        let envelope_json = serde_json::to_value(&signal.envelope)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let client = self.client.lock().await;
        let row = client
            .query_one(
                "INSERT INTO vidcall_signals (room_id, envelope_json, received_at)
                 VALUES ($1, $2, $3) RETURNING seq",
                &[&signal.room_id, &envelope_json, &signal.received_at],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres write failed: {e}")))?;
        let seq: i64 = row.get(0);
        Ok(StoredSignal {
            room_id: signal.room_id,
            seq,
            envelope: signal.envelope,
            received_at: signal.received_at,
        })
    }

    async fn list_signals(&self, room_id: &str, since: i64) -> Result<Vec<StoredSignal>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT seq, envelope_json, received_at FROM vidcall_signals
                 WHERE room_id = $1 AND seq > $2 ORDER BY seq",
                &[&room_id, &since],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres query failed: {e}")))?;
        rows.iter()
            .map(|r| {
                Ok(StoredSignal {
                    room_id: room_id.to_string(),
                    seq: r.get::<_, i64>(0),
                    envelope: serde_json::from_value(r.get::<_, serde_json::Value>(1)).map_err(
                        |e| VidcallError::internal_error(format!("postgres decode failed: {e}")),
                    )?,
                    received_at: r.get::<_, i64>(2),
                })
            })
            .collect()
    }

    // ---- recordings ------------------------------------------------------

    async fn put_recording(&self, recording: &RecordingSession) -> Result<()> {
        let recording = recording.clone();
        let json = serde_json::to_value(&recording)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let client = self.client.lock().await;
        client
            .execute(
                "INSERT INTO vidcall_recordings (session_id, room_id, recording_json)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (session_id) DO UPDATE SET recording_json = EXCLUDED.recording_json",
                &[&recording.session_id, &recording.room_id, &json],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres write failed: {e}")))?;
        Ok(())
    }

    async fn list_recordings(&self, room_id: &str) -> Result<Vec<RecordingSession>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT recording_json FROM vidcall_recordings WHERE room_id = $1",
                &[&room_id],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres query failed: {e}")))?;
        rows.iter()
            .map(|r| serde_json::from_value(r.get::<_, serde_json::Value>(0)))
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| VidcallError::internal_error(format!("postgres decode failed: {e}")))
    }

    async fn get_recording(&self, session_id: &str) -> Result<Option<RecordingSession>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT recording_json FROM vidcall_recordings WHERE session_id = $1",
                &[&session_id],
            )
            .await
            .map_err(|e| VidcallError::internal_error(format!("postgres query failed: {e}")))?;
        rows.first()
            .map(|r| serde_json::from_value(r.get::<_, serde_json::Value>(0)))
            .transpose()
            .map_err(|e| VidcallError::internal_error(format!("postgres decode failed: {e}")))
    }

    // ---- change feed -----------------------------------------------------

    fn subscribe(&self, room_id: &str) -> Option<SignalStream> {
        let this = Poller {
            client: std::sync::Arc::clone(&self.client),
            room_id: room_id.to_string(),
            interval: self.poll_interval,
            since: 0,
        };
        Some(Box::new(polling_stream(this)))
    }
}

/// Polling change-feed state: each poll re-queries the signal log and emits
/// new signals (store-and-reference — no NOTIFY payload cap to worry about).
struct Poller {
    client: std::sync::Arc<tokio::sync::Mutex<Client>>,
    room_id: String,
    interval: Duration,
    since: i64,
}

/// An infinite stream that polls `list_signals` every `interval` and yields
/// new signals in seq order. Ends only when dropped.
fn polling_stream(poller: Poller) -> impl futures_util::Stream<Item = StoredSignal> + Send {
    use std::collections::VecDeque;
    struct State {
        poller: Poller,
        queue: VecDeque<StoredSignal>,
    }
    futures_util::stream::unfold(
        State {
            poller,
            queue: VecDeque::new(),
        },
        |mut st| async move {
            loop {
                if let Some(signal) = st.queue.pop_front() {
                    return Some((signal, st));
                }
                tokio::time::sleep(st.poller.interval).await;
                let client = st.poller.client.lock().await;
                let rows = client
                    .query(
                        "SELECT seq, envelope_json, received_at FROM vidcall_signals
                     WHERE room_id = $1 AND seq > $2 ORDER BY seq",
                        &[&st.poller.room_id, &st.poller.since],
                    )
                    .await;
                match rows {
                    Ok(rows) => {
                        for r in &rows {
                            let seq: i64 = r.get(0);
                            if seq > st.poller.since {
                                st.poller.since = seq;
                            }
                            if let Ok(envelope) =
                                serde_json::from_value(r.get::<_, serde_json::Value>(1))
                            {
                                st.queue.push_back(StoredSignal {
                                    room_id: st.poller.room_id.clone(),
                                    seq,
                                    envelope,
                                    received_at: r.get::<_, i64>(2),
                                });
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "postgres feed poll failed");
                    }
                }
            }
        },
    )
}
