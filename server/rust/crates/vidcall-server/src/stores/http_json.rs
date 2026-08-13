//! Generic [`Store`] over any REST/JSON backend ("HttpJsonStore" pattern).
//!
//! This is the documented pattern for BaaSes that expose a plain REST CRUD
//! API (Firebase Realtime Database, Appwrite, PocketBase, ...). The store
//! speaks one small, opinionated REST contract (see `DATABASES.md`) and
//! relies on the *backend* to assign per-room `seq` values atomically. The
//! change feed is a polling stream over the signals resource.
//!
//! REST contract (base URL + per-resource path, all JSON):
//!
//! ```text
//! GET    {base}/rooms/{roomId}                       → Room | 404
//! PUT    {base}/rooms/{roomId}                       → 204/200   (upsert)
//! DELETE {base}/rooms/{roomId}                       → 204
//! GET    {base}/participants/{roomId}/{participantId} → Participant | 404
//! PUT    {base}/participants/{roomId}/{participantId} → 204/200
//! DELETE {base}/participants/{roomId}/{participantId} → 204
//! GET    {base}/rooms/{roomId}/participants           → Participant[]
//! POST   {base}/rooms/{roomId}/signals                → {seq}      (body: {envelope, receivedAt})
//! GET    {base}/rooms/{roomId}/signals?since=N        → StoredSignal[]
//! PUT    {base}/recordings/{sessionId}                → 204/200
//! GET    {base}/rooms/{roomId}/recordings             → RecordingSession[]
//! GET    {base}/recordings/{sessionId}                → RecordingSession | 404
//! ```
//!
//! The generic model maps onto real BaaSes like this (`DATABASES.md` has the
//! full table):
//!
//! | BaaS | Mapping |
//! |---|---|
//! | Firebase RTDB | `rooms/{id}.json` etc. (path = resource) |
//! | Appwrite | `databases/{db}/collections/{col}/documents` (path per entity kind) |
//! | PocketBase | `api/collections/{col}/records` (collection per entity) |
//!
//! A small reference implementation of this contract is exercised by the
//! shared store suite against a mock server (see `tests/`).

use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{HeaderName, HeaderValue};
use url::Url;

use crate::error::{Result, VidcallError};
use crate::store::{SignalInput, SignalStream, Store};
use crate::types::{Participant, RecordingSession, Room, StoredSignal};

/// Configuration for the generic REST store.
#[derive(Debug, Clone)]
pub struct HttpJsonConfig {
    /// Base URL, e.g. `https://my-app.example.com/api/vidcall`.
    pub base_url: String,
    /// Extra headers sent on every request (auth, api keys, ...).
    pub headers: Vec<(String, String)>,
    /// Change-feed polling interval (default 250 ms).
    pub poll_interval: Duration,
    /// Optional custom reqwest client (tests).
    pub client: Option<reqwest::Client>,
}

impl HttpJsonConfig {
    /// Build a config with default poll interval and client.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            headers: Vec::new(),
            poll_interval: Duration::from_millis(250),
            client: None,
        }
    }
}

/// Generic REST/JSON store (see module docs).
#[derive(Clone)]
pub struct HttpJsonStore {
    cfg: HttpJsonConfig,
    client: reqwest::Client,
}

impl HttpJsonStore {
    /// Create a store from a config.
    pub fn new(cfg: HttpJsonConfig) -> Result<Self> {
        let client = cfg
            .client
            .clone()
            .unwrap_or_else(|| {
                reqwest::Client::builder()
                    .user_agent("vidcall-server/0.1 (HttpJsonStore)")
                    .build()
                    .expect("reqwest client build")
            });
        Ok(Self { cfg, client })
    }

    fn url(&self, path: &str) -> Result<Url> {
        let mut url = Url::parse(&self.cfg.base_url)
            .map_err(|e| VidcallError::internal_error(format!("invalid base_url: {e}")))?;
        url.set_path(&format!(
            "{}/{}",
            url.path().trim_end_matches('/'),
            path.trim_start_matches('/')
        ));
        Ok(url)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let req = req
            .headers(self.headers())
            .build()
            .map_err(|e| VidcallError::internal_error(format!("request build failed: {e}")))?;
        let resp = self
            .client
            .execute(req)
            .await
            .map_err(|e| VidcallError::internal_error(format!("http request failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable>".to_string());
            return Err(VidcallError::internal_error(format!(
                "http {status} from store backend: {body}"
            )));
        }
        Ok(resp)
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut map = reqwest::header::HeaderMap::new();
        for (k, v) in &self.cfg.headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                map.insert(name, value);
            }
        }
        map
    }

    async fn get_json(&self, path: &str) -> Result<Option<serde_json::Value>> {
        let url = self.url(path)?;
        let resp = self.send(self.client.get(url)).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json from backend: {e}")))?;
        if body.is_null() {
            return Ok(None);
        }
        Ok(Some(body))
    }

    async fn get_list(&self, path: &str) -> Result<Vec<serde_json::Value>> {
        let url = self.url(path)?;
        let resp = self.send(self.client.get(url)).await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json from backend: {e}")))?;
        match body {
            serde_json::Value::Array(items) => Ok(items),
            other => Ok(vec![other]),
        }
    }

    async fn put_json(&self, path: &str, body: &serde_json::Value) -> Result<()> {
        let url = self.url(path)?;
        self.send(self.client.put(url).json(body)).await?;
        Ok(())
    }

    async fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
        let url = self.url(path)?;
        let resp = self.send(self.client.post(url).json(body)).await?;
        resp.json()
            .await
            .map_err(|e| VidcallError::internal_error(format!("bad json from backend: {e}")))
    }

    async fn delete(&self, path: &str) -> Result<()> {
        let url = self.url(path)?;
        self.send(self.client.delete(url)).await?;
        Ok(())
    }
}

fn decode<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T> {
    serde_json::from_value(v)
        .map_err(|e| VidcallError::internal_error(format!("store decode failed: {e}")))
}

#[async_trait]
impl Store for HttpJsonStore {
    async fn get_room(&self, room_id: &str) -> Result<Option<Room>> {
        self.get_json(&format!("rooms/{room_id}"))
            .await?
            .map(decode::<Room>)
            .transpose()
    }

    async fn put_room(&self, room: &Room) -> Result<()> {
        let body = serde_json::to_value(room)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.put_json(&format!("rooms/{}", room.room_id), &body).await
    }

    async fn delete_room(&self, room_id: &str) -> Result<()> {
        self.delete(&format!("rooms/{room_id}")).await
    }

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> Result<Option<Participant>> {
        self.get_json(&format!("participants/{room_id}/{participant_id}"))
            .await?
            .map(decode::<Participant>)
            .transpose()
    }

    async fn put_participant(&self, participant: &Participant) -> Result<()> {
        let body = serde_json::to_value(participant)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.put_json(
            &format!(
                "participants/{}/{}",
                participant.room_id, participant.participant_id
            ),
            &body,
        )
        .await
    }

    async fn delete_participant(&self, room_id: &str, participant_id: &str) -> Result<()> {
        self.delete(&format!("participants/{room_id}/{participant_id}"))
            .await
    }

    async fn list_participants(&self, room_id: &str) -> Result<Vec<Participant>> {
        let items = self
            .get_list(&format!("rooms/{room_id}/participants"))
            .await?;
        items.into_iter().map(decode::<Participant>).collect()
    }

    async fn put_signal(&self, signal: SignalInput) -> Result<StoredSignal> {
        let body = serde_json::json!({
            "envelope": signal.envelope,
            "receivedAt": signal.received_at,
        });
        let resp = self
            .post_json(&format!("rooms/{}/signals", signal.room_id), &body)
            .await?;
        let seq = resp
            .get("seq")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| VidcallError::internal_error("backend did not return seq"))?;
        Ok(StoredSignal {
            room_id: signal.room_id,
            seq,
            envelope: signal.envelope,
            received_at: signal.received_at,
        })
    }

    async fn list_signals(&self, room_id: &str, since: i64) -> Result<Vec<StoredSignal>> {
        let items = self
            .get_list(&format!("rooms/{room_id}/signals?since={since}"))
            .await?;
        items.into_iter().map(decode::<StoredSignal>).collect()
    }

    async fn put_recording(&self, recording: &RecordingSession) -> Result<()> {
        let body = serde_json::to_value(recording)
            .map_err(|e| VidcallError::internal_error(format!("encode failed: {e}")))?;
        self.put_json(&format!("recordings/{}", recording.session_id), &body)
            .await
    }

    async fn list_recordings(&self, room_id: &str) -> Result<Vec<RecordingSession>> {
        let items = self
            .get_list(&format!("rooms/{room_id}/recordings"))
            .await?;
        items.into_iter().map(decode::<RecordingSession>).collect()
    }

    async fn get_recording(&self, session_id: &str) -> Result<Option<RecordingSession>> {
        self.get_json(&format!("recordings/{session_id}"))
            .await?
            .map(decode::<RecordingSession>)
            .transpose()
    }

    fn subscribe(&self, room_id: &str) -> Option<SignalStream> {
        // Polling stream over the signals resource.
        let store = self.clone();
        let room_id = room_id.to_string();
        Some(Box::new(polling_stream(store, room_id, self.cfg.poll_interval)))
    }
}

/// Poll the signals resource every `interval`, yielding new signals.
fn polling_stream(
    store: HttpJsonStore,
    room_id: String,
    interval: Duration,
) -> impl futures_util::Stream<Item = StoredSignal> + Send {
    use std::collections::VecDeque;
    struct State {
        store: HttpJsonStore,
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
                match st
                    .store
                    .list_signals(&st.room_id, st.since)
                    .await
                {
                    Ok(signals) => {
                        for s in &signals {
                            if s.seq > st.since {
                                st.since = s.seq;
                            }
                        }
                        st.queue.extend(signals);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "http-json feed poll failed");
                    }
                }
            }
        },
    )
}
