//! Convex [`Store`] — talks to the **Convex HTTP API** (the public
//! `POST /api/query` and `POST /api/mutation` endpoints, per the docs at
//! docs.convex.dev/http-api), not the WebSocket client.
//!
//! Wire format (verified against the Convex docs):
//!
//! ```text
//! POST https://<deployment>.convex.cloud/api/query
//!   { "path": "vidcall:getRoom", "args": { "roomId": "r1" }, "format": "json" }
//! → { "status": "success", "value": { ... } }
//! ```
//!
//! Mutations are serialized and transactional in Convex, so the reference
//! `putSignal` mutation (see `convex-reference/`) assigns the per-room
//! monotonic `seq` atomically (MAX+1 over the room's signal docs inside the
//! same mutation).
//!
//! Setup:
//!  1. Copy `convex-reference/` (schema.ts + vidcall.ts) into your Convex
//!     project and deploy.
//!  2. Point the store at your deployment:
//!
//! ```no_run
//! use vidcall_server::stores::ConvexStore;
//! # async fn example() {
//! let store = ConvexStore::new("https://<deployment>.convex.cloud")
//!     .expect("valid url");
//! # let _ = store;
//! # }
//! ```
//!
//! Reads are plain HTTP requests; for push you can either poll
//! ([`Store::subscribe`], polling stream) or point the sidecar's WS relay at
//! a long-poll bridge. 16 MiB arg/return caps mean SDP/ICE never need
//! chunking.

use std::time::Duration;

use async_trait::async_trait;
use url::Url;

use crate::error::{Result, VidcallError};
use crate::store::{SignalInput, SignalStream, Store};
use serde_json::json;

use crate::types::{Participant, RecordingSession, Room, StoredSignal};

/// Default module prefix for the reference functions (`convex-reference/`).
/// Change together with the module name if you rename the file.
pub const DEFAULT_FUNCTION_PREFIX: &str = "vidcall";

/// Convex store configuration.
#[derive(Debug, Clone)]
pub struct ConvexConfig {
    /// Deployment URL, e.g. `https://acoustic-panther-728.convex.cloud`.
    pub url: String,
    /// Module prefix for the reference functions.
    pub function_prefix: String,
    /// Change-feed polling interval (default 250 ms).
    pub poll_interval: Duration,
    /// Optional custom reqwest client (tests).
    pub client: Option<reqwest::Client>,
}

impl ConvexConfig {
    /// Build a config with defaults.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            function_prefix: DEFAULT_FUNCTION_PREFIX.to_string(),
            poll_interval: Duration::from_millis(250),
            client: None,
        }
    }
}

/// Convex store (see module docs).
#[derive(Clone)]
pub struct ConvexStore {
    cfg: ConvexConfig,
    client: reqwest::Client,
}

impl ConvexStore {
    /// Create a store for a Convex deployment URL.
    pub fn new(url: impl Into<String>) -> Result<Self> {
        Self::from_config(ConvexConfig::new(url))
    }

    /// Create a store from a config.
    pub fn from_config(cfg: ConvexConfig) -> Result<Self> {
        // Validate the URL early.
        Url::parse(&cfg.url)
            .map_err(|e| VidcallError::internal_error(format!("invalid convex url: {e}")))?;
        let client = cfg.client.clone().unwrap_or_else(|| {
            reqwest::Client::builder()
                .user_agent("vidcall-server/0.1 (ConvexStore)")
                .build()
                .expect("reqwest client build")
        });
        Ok(Self { cfg, client })
    }

    fn fn_path(&self, name: &str) -> String {
        format!("{}:{name}", self.cfg.function_prefix)
    }

    /// Call one Convex function; returns the `value` on success.
    async fn call(
        &self,
        kind: &str,
        path: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let url = format!("{}/api/{kind}", self.cfg.url.trim_end_matches('/'));
        let body = serde_json::json!({
            "path": path,
            "args": args,
            "format": "json",
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| VidcallError::internal_error(format!("convex request failed: {e}")))?;
        let status = resp.status().as_u16();
        let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if status != 200 {
            let message = json
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("convex function failed");
            return Err(VidcallError::internal_error(format!(
                "convex {kind} {path} failed ({status}): {message}"
            )));
        }
        if json.get("status").and_then(serde_json::Value::as_str) != Some("success") {
            return Err(VidcallError::internal_error(format!(
                "convex {kind} {path} failed: {json}"
            )));
        }
        Ok(json
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    async fn query(&self, path: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        self.call("query", path, args).await
    }

    async fn mutation(&self, path: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        self.call("mutation", path, args).await
    }
}

fn decode<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T> {
    serde_json::from_value(v)
        .map_err(|e| VidcallError::internal_error(format!("convex decode failed: {e}")))
}

fn opt<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<Option<T>> {
    if v.is_null() {
        Ok(None)
    } else {
        decode(v).map(Some)
    }
}

#[async_trait]
impl Store for ConvexStore {
    async fn get_room(&self, room_id: &str) -> Result<Option<Room>> {
        opt(self
            .query(&self.fn_path("getRoom"), json!({ "roomId": room_id }))
            .await?)
    }

    async fn put_room(&self, room: &Room) -> Result<()> {
        let value = serde_json::to_value(room)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.mutation(&self.fn_path("putRoom"), json!({ "room": value }))
            .await?;
        Ok(())
    }

    async fn delete_room(&self, room_id: &str) -> Result<()> {
        self.mutation(&self.fn_path("deleteRoom"), json!({ "roomId": room_id }))
            .await?;
        Ok(())
    }

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> Result<Option<Participant>> {
        opt(self
            .query(
                &self.fn_path("getParticipant"),
                json!({ "roomId": room_id, "participantId": participant_id }),
            )
            .await?)
    }

    async fn put_participant(&self, participant: &Participant) -> Result<()> {
        let value = serde_json::to_value(participant)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.mutation(
            &self.fn_path("putParticipant"),
            json!({ "participant": value }),
        )
        .await?;
        Ok(())
    }

    async fn delete_participant(&self, room_id: &str, participant_id: &str) -> Result<()> {
        self.mutation(
            &self.fn_path("deleteParticipant"),
            json!({ "roomId": room_id, "participantId": participant_id }),
        )
        .await?;
        Ok(())
    }

    async fn list_participants(&self, room_id: &str) -> Result<Vec<Participant>> {
        let value = self
            .query(
                &self.fn_path("listParticipants"),
                json!({ "roomId": room_id }),
            )
            .await?;
        let items = value.as_array().cloned().unwrap_or_default();
        items.into_iter().map(decode::<Participant>).collect()
    }

    async fn put_signal(&self, signal: SignalInput) -> Result<StoredSignal> {
        let envelope = serde_json::to_value(&signal.envelope)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        let value = self
            .mutation(
                &self.fn_path("putSignal"),
                json!({
                    "roomId": signal.room_id,
                    "envelope": envelope,
                    "receivedAt": signal.received_at,
                }),
            )
            .await?;
        let seq = value
            .get("seq")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| VidcallError::internal_error("convex putSignal did not return seq"))?;
        Ok(StoredSignal {
            room_id: signal.room_id,
            seq,
            envelope: signal.envelope,
            received_at: signal.received_at,
        })
    }

    async fn list_signals(&self, room_id: &str, since: i64) -> Result<Vec<StoredSignal>> {
        let value = self
            .query(
                &self.fn_path("listSignals"),
                json!({ "roomId": room_id, "since": since }),
            )
            .await?;
        let items = value.as_array().cloned().unwrap_or_default();
        items.into_iter().map(decode::<StoredSignal>).collect()
    }

    async fn put_recording(&self, recording: &RecordingSession) -> Result<()> {
        let value = serde_json::to_value(recording)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.mutation(&self.fn_path("putRecording"), json!({ "recording": value }))
            .await?;
        Ok(())
    }

    async fn list_recordings(&self, room_id: &str) -> Result<Vec<RecordingSession>> {
        let value = self
            .query(
                &self.fn_path("listRecordings"),
                json!({ "roomId": room_id }),
            )
            .await?;
        let items = value.as_array().cloned().unwrap_or_default();
        items.into_iter().map(decode::<RecordingSession>).collect()
    }

    async fn get_recording(&self, session_id: &str) -> Result<Option<RecordingSession>> {
        opt(self
            .query(
                &self.fn_path("getRecording"),
                json!({ "sessionId": session_id }),
            )
            .await?)
    }

    fn subscribe(&self, room_id: &str) -> Option<SignalStream> {
        let store = self.clone();
        let room_id = room_id.to_string();
        Some(Box::new(polling_stream(
            store,
            room_id,
            self.cfg.poll_interval,
        )))
    }
}

/// Poll `listSignals` every `interval`, yielding new signals.
fn polling_stream(
    store: ConvexStore,
    room_id: String,
    interval: Duration,
) -> impl futures_util::Stream<Item = StoredSignal> + Send {
    use std::collections::VecDeque;
    struct State {
        store: ConvexStore,
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
                        tracing::warn!(error = %e, "convex feed poll failed");
                    }
                }
            }
        },
    )
}
