//! Supabase [`Store`] — PostgREST REST CRUD against your Supabase project.
//!
//! Supabase **is** PostgreSQL, so [`PostgresStore`](super::PostgresStore)
//! also works (direct DB connection; enable the `pg-tls` feature for
//! `sslmode=require`). This store is the HTTP path: it talks to the
//! PostgREST API (`https://<ref>.supabase.co/rest/v1`) with the project's
//! `apikey`/`Authorization` headers, so it works in any network position
//! (serverless, edge, sidecar) without a direct DB connection.
//!
//! Setup:
//!  1. Create the four tables (SQL in `DATABASES.md`, same schema as the
//!     Postgres store) — `vidcall_rooms`, `vidcall_participants`,
//!     `vidcall_signals`, `vidcall_recordings` — and enable RLS for your app
//!     role.
//!  2. Point the store at your project:
//!
//! ```no_run
//! use vidcall_server::stores::SupabaseStore;
//! # async fn example() {
//! let store = SupabaseStore::new(
//!     "https://<ref>.supabase.co",
//!     "<service-role-or-anon-key>",
//! ).expect("valid url");
//! # let _ = store;
//! # }
//! ```
//!
//! PostgREST notes:
//!  - Upserts use `POST ?on_conflict=<pk>` with `Prefer: resolution=merge-duplicates`.
//!  - `put_signal` POSTs a row and reads back the server-assigned `seq`
//!    (`Prefer: return=representation`); the `BIGSERIAL` identity column
//!    keeps per-room ordering atomic, exactly like the Postgres store.
//!  - Reads filter with `?col=eq.<value>` and `&col=gt.<value>` (PostgREST
//!    operators); ordering with `&order=seq.asc`.

use std::time::Duration;

use async_trait::async_trait;
use url::Url;

use crate::error::{Result, VidcallError};
use crate::store::{SignalInput, SignalStream, Store};

use crate::types::{Participant, RecordingSession, Room, StoredSignal};

/// Supabase store configuration.
#[derive(Debug, Clone)]
pub struct SupabaseConfig {
    /// Project URL, e.g. `https://abcdefgh.supabase.co`.
    pub url: String,
    /// Service-role (or anon) API key.
    pub key: String,
    /// Change-feed polling interval (default 250 ms).
    pub poll_interval: Duration,
    /// Optional custom reqwest client (tests).
    pub client: Option<reqwest::Client>,
}

impl SupabaseConfig {
    /// Build a config with defaults.
    pub fn new(url: impl Into<String>, key: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            key: key.into(),
            poll_interval: Duration::from_millis(250),
            client: None,
        }
    }
}

/// Supabase/PostgREST store (see module docs).
#[derive(Clone)]
pub struct SupabaseStore {
    cfg: SupabaseConfig,
    client: reqwest::Client,
}

impl SupabaseStore {
    /// Create a store for a Supabase project URL + API key.
    pub fn new(url: impl Into<String>, key: impl Into<String>) -> Result<Self> {
        Self::from_config(SupabaseConfig::new(url, key))
    }

    /// Create a store from a config.
    pub fn from_config(cfg: SupabaseConfig) -> Result<Self> {
        Url::parse(&cfg.url)
            .map_err(|e| VidcallError::internal_error(format!("invalid supabase url: {e}")))?;
        let client = cfg
            .client
            .clone()
            .unwrap_or_else(|| {
                reqwest::Client::builder()
                    .user_agent("vidcall-server/0.1 (SupabaseStore)")
                    .build()
                    .expect("reqwest client build")
            });
        Ok(Self { cfg, client })
    }

    fn url(&self, path: &str) -> Result<Url> {
        let url = Url::parse(&format!(
            "{}/rest/v1/{}",
            self.cfg.url.trim_end_matches('/'),
            path.trim_start_matches('/')
        ))
        .map_err(|e| VidcallError::internal_error(format!("invalid supabase url: {e}")))?;
        Ok(url)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let req = req
            .header("apikey", &self.cfg.key)
            .header("Authorization", format!("Bearer {}", self.cfg.key))
            .build()
            .map_err(|e| VidcallError::internal_error(format!("request build failed: {e}")))?;
        let resp = self
            .client
            .execute(req)
            .await
            .map_err(|e| VidcallError::internal_error(format!("supabase request failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(VidcallError::internal_error(format!(
                "supabase http {status}: {body}"
            )));
        }
        Ok(resp)
    }

    /// GET a table row filtered by a column value; returns the first row.
    async fn get_row(&self, table: &str, col: &str, value: &str) -> Result<Option<serde_json::Value>> {
        let mut url = self.url(table)?;
        url.query_pairs_mut()
            .append_pair(col, &format!("eq.{value}"))
            .append_pair("select", "*")
            .append_pair("limit", "1");
        let resp = self.send(self.client.get(url)).await?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))?;
        Ok(rows.into_iter().next())
    }

    /// Upsert one row (PostgREST POST + on_conflict + merge-duplicates).
    async fn upsert(&self, table: &str, pk: &str, row: serde_json::Value) -> Result<()> {
        let mut url = self.url(table)?;
        url.query_pairs_mut().append_pair("on_conflict", pk);
        self.send(
            self.client
                .post(url)
                .header("Prefer", "resolution=merge-duplicates")
                .json(&row),
        )
        .await?;
        Ok(())
    }

    async fn delete_row(&self, table: &str, col: &str, value: &str) -> Result<()> {
        let mut url = self.url(table)?;
        url.query_pairs_mut().append_pair(col, &format!("eq.{value}"));
        self.send(self.client.delete(url)).await?;
        Ok(())
    }

    #[allow(dead_code)]
    async fn list_all(&self, table: &str) -> Result<Vec<serde_json::Value>> {
        let url = self.url(table)?;
        let resp = self.send(self.client.get(url)).await?;
        resp.json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))
    }
}

fn decode<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T> {
    serde_json::from_value(v).map_err(|e| VidcallError::internal_error(format!("decode failed: {e}")))
}

fn opt<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<Option<T>> {
    if v.is_null() {
        Ok(None)
    } else {
        decode(v).map(Some)
    }
}

#[async_trait]
impl Store for SupabaseStore {
    async fn get_room(&self, room_id: &str) -> Result<Option<Room>> {
        match self.get_row("vidcall_rooms", "room_id", room_id).await? {
            Some(row) => opt::<Room>(row.get("room_json").cloned().unwrap_or(row)),
            None => Ok(None),
        }
    }

    async fn put_room(&self, room: &Room) -> Result<()> {
        let json = serde_json::to_value(room)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.upsert(
            "vidcall_rooms",
            "room_id",
            serde_json::json!({ "room_id": room.room_id, "room_json": json }),
        )
        .await
    }

    async fn delete_room(&self, room_id: &str) -> Result<()> {
        for (table, col) in [
            ("vidcall_rooms", "room_id"),
            ("vidcall_participants", "room_id"),
            ("vidcall_signals", "room_id"),
            ("vidcall_recordings", "room_id"),
        ] {
            self.delete_row(table, col, room_id).await?;
        }
        Ok(())
    }

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> Result<Option<Participant>> {
        let mut url = self.url("vidcall_participants")?;
        url.query_pairs_mut()
            .append_pair("room_id", &format!("eq.{room_id}"))
            .append_pair("participant_id", &format!("eq.{participant_id}"))
            .append_pair("select", "*")
            .append_pair("limit", "1");
        let resp = self.send(self.client.get(url)).await?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))?;
        match rows.into_iter().next() {
            Some(row) => opt::<Participant>(row.get("participant_json").cloned().unwrap_or(row)),
            None => Ok(None),
        }
    }

    async fn put_participant(&self, participant: &Participant) -> Result<()> {
        let json = serde_json::to_value(participant)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.upsert(
            "vidcall_participants",
            "room_id,participant_id",
            serde_json::json!({
                "room_id": participant.room_id,
                "participant_id": participant.participant_id,
                "participant_json": json,
            }),
        )
        .await
    }

    async fn delete_participant(&self, room_id: &str, participant_id: &str) -> Result<()> {
        let mut url = self.url("vidcall_participants")?;
        url.query_pairs_mut()
            .append_pair("room_id", &format!("eq.{room_id}"))
            .append_pair("participant_id", &format!("eq.{participant_id}"));
        self.send(self.client.delete(url)).await?;
        Ok(())
    }

    async fn list_participants(&self, room_id: &str) -> Result<Vec<Participant>> {
        let mut url = self.url("vidcall_participants")?;
        url.query_pairs_mut()
            .append_pair("room_id", &format!("eq.{room_id}"))
            .append_pair("select", "*");
        let resp = self.send(self.client.get(url)).await?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            let json = row.get("participant_json").cloned().unwrap_or(row);
            out.push(decode::<Participant>(json)?);
        }
        out.sort_by(|a, b| {
            a.joined_at
                .cmp(&b.joined_at)
                .then_with(|| a.participant_id.cmp(&b.participant_id))
        });
        Ok(out)
    }

    async fn put_signal(&self, signal: SignalInput) -> Result<StoredSignal> {
        let envelope = serde_json::to_value(&signal.envelope)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let mut url = self.url("vidcall_signals")?;
        url.query_pairs_mut().append_pair("select", "seq");
        let resp = self
            .send(
                self.client
                    .post(url)
                    .header("Prefer", "return=representation")
                    .json(&serde_json::json!({
                        "room_id": signal.room_id,
                        "envelope_json": envelope,
                        "received_at": signal.received_at,
                    })),
            )
            .await?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))?;
        let seq = rows
            .first()
            .and_then(|r| r.get("seq"))
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| VidcallError::internal_error("supabase did not return seq"))?;
        Ok(StoredSignal {
            room_id: signal.room_id,
            seq,
            envelope: signal.envelope,
            received_at: signal.received_at,
        })
    }

    async fn list_signals(&self, room_id: &str, since: i64) -> Result<Vec<StoredSignal>> {
        let mut url = self.url("vidcall_signals")?;
        url.query_pairs_mut()
            .append_pair("room_id", &format!("eq.{room_id}"))
            .append_pair("seq", &format!("gt.{since}"))
            .append_pair("order", "seq.asc")
            .append_pair("select", "*");
        let resp = self.send(self.client.get(url)).await?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))?;
        rows.into_iter()
            .map(|row| {
                let room_id = row
                    .get("room_id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(room_id)
                    .to_string();
                let seq = row.get("seq").and_then(serde_json::Value::as_i64).unwrap_or(0);
                let received_at = row.get("received_at").and_then(serde_json::Value::as_i64).unwrap_or(0);
                let envelope = decode::<crate::protocol::Envelope>(
                    row.get("envelope_json").cloned().unwrap_or(serde_json::Value::Null),
                )?;
                Ok(StoredSignal {
                    room_id,
                    seq,
                    envelope,
                    received_at,
                })
            })
            .collect()
    }

    async fn put_recording(&self, recording: &RecordingSession) -> Result<()> {
        let json = serde_json::to_value(recording)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.upsert(
            "vidcall_recordings",
            "session_id",
            serde_json::json!({
                "session_id": recording.session_id,
                "room_id": recording.room_id,
                "recording_json": json,
            }),
        )
        .await
    }

    async fn list_recordings(&self, room_id: &str) -> Result<Vec<RecordingSession>> {
        let mut url = self.url("vidcall_recordings")?;
        url.query_pairs_mut()
            .append_pair("room_id", &format!("eq.{room_id}"))
            .append_pair("select", "*");
        let resp = self.send(self.client.get(url)).await?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json: {e}")))?;
        rows.into_iter()
            .map(|row| decode::<RecordingSession>(row.get("recording_json").cloned().unwrap_or(row)))
            .collect()
    }

    async fn get_recording(&self, session_id: &str) -> Result<Option<RecordingSession>> {
        match self.get_row("vidcall_recordings", "session_id", session_id).await? {
            Some(row) => opt::<RecordingSession>(row.get("recording_json").cloned().unwrap_or(row)),
            None => Ok(None),
        }
    }

    fn subscribe(&self, room_id: &str) -> Option<SignalStream> {
        let store = self.clone();
        let room_id = room_id.to_string();
        Some(Box::new(polling_stream(store, room_id, self.cfg.poll_interval)))
    }
}

/// Poll `vidcall_signals` every `interval`, yielding new signals.
fn polling_stream(
    store: SupabaseStore,
    room_id: String,
    interval: Duration,
) -> impl futures_util::Stream<Item = StoredSignal> + Send {
    use std::collections::VecDeque;
    struct State {
        store: SupabaseStore,
        room_id: String,
        interval: Duration,
        since: i64,
        queue: VecDeque<StoredSignal>,
    }
    futures_util::stream::unfold(
        State {
            store,
            room_id,
            interval,
            since: 0,
            queue: VecDeque::new(),
        },
        |mut st| async move {
            loop {
                if let Some(signal) = st.queue.pop_front() {
                    return Some((signal, st));
                }
                tokio::time::sleep(st.interval).await;
                match st.store.list_signals(&st.room_id, st.since).await {
                    Ok(signals) => {
                        for s in &signals {
                            if s.seq > st.since {
                                st.since = s.seq;
                            }
                        }
                        st.queue.extend(signals);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "supabase feed poll failed");
                    }
                }
            }
        },
    )
}
