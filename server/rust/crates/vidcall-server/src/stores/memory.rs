//! In-memory [`Store`] — the reference implementation and the one used by the
//! test suite, dev servers, and single-process demos. Every other store must
//! behave identically.
//!
//! Not for multi-process production use: state lives in one process. The
//! change feed ([`Store::subscribe`]) is an in-process broadcast channel.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::Stream;
use tokio::sync::broadcast;

use crate::error::Result;
use crate::store::{SignalInput, SignalStream, Store};
use crate::types::{Participant, RecordingSession, Room, StoredSignal};

/// Key for the participants map: `room_id + '\0' + participant_id`.
fn participant_key(room_id: &str, participant_id: &str) -> String {
    format!("{room_id}\0{participant_id}")
}

/// Default broadcast capacity for the per-room change feed.
const FEED_CAPACITY: usize = 256;

/// In-memory store (see module docs).
#[derive(Clone, Default)]
pub struct InMemoryStore {
    inner: Arc<std::sync::Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, Room>,
    participants: HashMap<String, Participant>,
    signals: HashMap<String, Vec<StoredSignal>>,
    signal_seqs: HashMap<String, i64>,
    recordings: HashMap<String, RecordingSession>,
    feeds: HashMap<String, broadcast::Sender<StoredSignal>>,
}

impl InMemoryStore {
    /// Create an empty in-memory store.
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the store holds any state (test helper).
    pub fn is_empty(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.rooms.is_empty()
            && inner.participants.is_empty()
            && inner.signals.is_empty()
            && inner.recordings.is_empty()
    }
}

#[async_trait]
impl Store for InMemoryStore {
    // ---- rooms -----------------------------------------------------------

    async fn get_room(&self, room_id: &str) -> Result<Option<Room>> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.rooms.get(room_id).cloned())
    }

    async fn put_room(&self, room: &Room) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.rooms.insert(room.room_id.clone(), room.clone());
        Ok(())
    }

    async fn delete_room(&self, room_id: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.rooms.remove(room_id);
        inner
            .participants
            .retain(|k, _| !k.starts_with(&format!("{room_id}\0")));
        inner.signals.remove(room_id);
        inner.signal_seqs.remove(room_id);
        inner.feeds.remove(room_id);
        inner
            .recordings
            .retain(|_, r| r.room_id != room_id);
        Ok(())
    }

    // ---- participants ----------------------------------------------------

    async fn get_participant(
        &self,
        room_id: &str,
        participant_id: &str,
    ) -> Result<Option<Participant>> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .participants
            .get(&participant_key(room_id, participant_id))
            .cloned())
    }

    async fn put_participant(&self, participant: &Participant) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.participants.insert(
            participant_key(&participant.room_id, &participant.participant_id),
            participant.clone(),
        );
        Ok(())
    }

    async fn delete_participant(&self, room_id: &str, participant_id: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .participants
            .remove(&participant_key(room_id, participant_id));
        Ok(())
    }

    async fn list_participants(&self, room_id: &str) -> Result<Vec<Participant>> {
        let inner = self.inner.lock().unwrap();
        let prefix = format!("{room_id}\0");
        let mut out: Vec<Participant> = inner
            .participants
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, p)| p.clone())
            .collect();
        out.sort_by(|a, b| {
            a.joined_at
                .cmp(&b.joined_at)
                .then_with(|| a.participant_id.cmp(&b.participant_id))
        });
        Ok(out)
    }

    // ---- signals ---------------------------------------------------------

    async fn put_signal(&self, signal: SignalInput) -> Result<StoredSignal> {
        let stored = {
            let mut inner = self.inner.lock().unwrap();
            let seq = inner.signal_seqs.get(&signal.room_id).copied().unwrap_or(0) + 1;
            inner.signal_seqs.insert(signal.room_id.clone(), seq);
            let stored = StoredSignal {
                room_id: signal.room_id.clone(),
                seq,
                envelope: signal.envelope,
                received_at: signal.received_at,
            };
            inner
                .signals
                .entry(signal.room_id.clone())
                .or_default()
                .push(stored.clone());
            stored
        };
        // Publish to the change feed outside the lock.
        if let Some(tx) = self.inner.lock().unwrap().feeds.get(&stored.room_id) {
            let _ = tx.send(stored.clone());
        }
        Ok(stored)
    }

    async fn list_signals(&self, room_id: &str, since: i64) -> Result<Vec<StoredSignal>> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .signals
            .get(room_id)
            .map(|list| {
                list.iter()
                    .filter(|s| s.seq > since)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default())
    }

    // ---- recordings ------------------------------------------------------

    async fn put_recording(&self, recording: &RecordingSession) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .recordings
            .insert(recording.session_id.clone(), recording.clone());
        Ok(())
    }

    async fn list_recordings(&self, room_id: &str) -> Result<Vec<RecordingSession>> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .recordings
            .values()
            .filter(|r| r.room_id == room_id)
            .cloned()
            .collect())
    }

    async fn get_recording(&self, session_id: &str) -> Result<Option<RecordingSession>> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.recordings.get(session_id).cloned())
    }

    // ---- change feed -----------------------------------------------------

    fn subscribe(&self, room_id: &str) -> Option<SignalStream> {
        let mut inner = self.inner.lock().unwrap();
        let tx = inner
            .feeds
            .entry(room_id.to_string())
            .or_insert_with(|| broadcast::channel(FEED_CAPACITY).0)
            .clone();
        let rx = tx.subscribe();
        Some(Box::new(broadcast_stream(rx)))
    }
}

/// Turn a `broadcast::Receiver` into a stream that ends when the channel
/// closes. Lagged receivers skip missed signals (relay semantics).
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
