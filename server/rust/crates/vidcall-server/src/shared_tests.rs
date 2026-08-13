//! SHARED store test suite — mirror of `packages/server/src/shared-tests.ts`.
//!
//! Every [`Store`] implementation must pass this exact matrix — the same idea
//! as the client's shared adapter suite (`@vidcall/transport/shared-tests`).
//! Run it from each store's test file:
//!
//! ```
//! use vidcall_server::stores::InMemoryStore;
//! use vidcall_server::shared_tests::{run_store_test_suite, StoreHarness};
//!
//! #[tokio::test]
//! async fn memory_passes_shared_suite() {
//!     run_store_test_suite(StoreHarness {
//!         name: "memory",
//!         create_store: Box::new(|| Box::pin(async { Ok(Box::new(InMemoryStore::new()) as Box<dyn Store>) })),
//!         destroy_store: None,
//!         room_prefix: Some("shared".to_string()),
//!     }).await;
//! }
//! ```
//!
//! The suite runs inside a single `tokio::test` so stores that need one
//! runtime (e.g. a background poller) are easy to drive.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use crate::core::{
    close_room, create_room, get_room_state, handle_signal, join_room, leave_room, start_recording,
    stop_recording, ParticipantInput,
};
use crate::error::VidcallError;
use crate::protocol::create_envelope;
use crate::store::Store;

static SUITE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Fresh-store factory used by the shared suite.
pub struct StoreHarness {
    /// Store name (used in failure messages / unique room ids).
    pub name: &'static str,
    /// Fresh, empty store per test.
    pub create_store: Box<
        dyn Fn() -> std::pin::Pin<
                Box<dyn std::future::Future<Output = crate::error::Result<Box<dyn Store>>> + Send>,
            > + Send
            + Sync,
    >,
    /// Tear down (close pools, delete temp dirs, ...).
    pub destroy_store: Option<
        Box<
            dyn Fn(
                    Box<dyn Store>,
                )
                    -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
                + Send
                + Sync,
        >,
    >,
    /// Unique-room-id prefix to avoid cross-run collisions.
    pub room_prefix: Option<String>,
}

fn room_id(prefix: &str, name: &str) -> String {
    let n = SUITE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{prefix}-{name}-r{n}")
}

fn participant(id: &str) -> ParticipantInput {
    ParticipantInput {
        participant_id: id.to_string(),
        session_id: format!("session-{id}"),
        display_name: Some(format!("User {id}")),
        metadata: None,
    }
}

/// Run the full shared suite against one store.
pub async fn run_store_test_suite(h: StoreHarness) {
    let prefix = h
        .room_prefix
        .clone()
        .unwrap_or_else(|| "shared".to_string());
    let name = h.name;

    // ---- rooms -----------------------------------------------------------
    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        let room = create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                max_participants: Some(4),
                metadata: Some(json!({"topic": "standup", "nested": {"a": [1, 2, 3]}})),
                now: None,
            },
        )
        .await
        .expect("create_room");
        let fetched = store.get_room(&id).await.unwrap().expect("room exists");
        assert_eq!(fetched.room_id, id);
        assert_eq!(format!("{:?}", fetched.state), "Open");
        assert_eq!(fetched.max_participants, Some(4));
        assert_eq!(
            fetched.metadata,
            Some(json!({"topic": "standup", "nested": {"a": [1, 2, 3]}}))
        );
        assert_eq!(room.created_at, fetched.created_at);
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let err = create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "room_already_exists");
        destroy(&h, store).await;
    }

    // ---- join / roster ---------------------------------------------------
    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let a = join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let b = join_room(&*store, &id, participant("bob"), Default::default())
            .await
            .unwrap();
        assert_eq!(a.participants.len(), 1);
        assert_eq!(b.participants.len(), 2);
        let roster = store.list_participants(&id).await.unwrap();
        assert_eq!(
            roster
                .iter()
                .map(|p| p.participant_id.as_str())
                .collect::<Vec<_>>(),
            vec!["alice", "bob"]
        );
        let alice = store
            .get_participant(&id, "alice")
            .await
            .unwrap()
            .expect("alice");
        assert_eq!(alice.display_name.as_deref(), Some("User alice"));
        assert_eq!(alice.session_id, "session-alice");
        assert_eq!(alice.joined_at, a.participant.joined_at);
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let err = join_room(
            &*store,
            &room_id(&prefix, name),
            participant("alice"),
            Default::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "room_not_found");
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let err = join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap_err();
        assert_eq!(err.code, "participant_already_joined");
        let result = join_room(
            &*store,
            &id,
            participant("alice"),
            crate::core::JoinRoomOptions {
                upsert: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(result.participants.len(), 1);
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                max_participants: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let err = join_room(&*store, &id, participant("bob"), Default::default())
            .await
            .unwrap_err();
        assert_eq!(err.code, "room_full");
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let closed = close_room(&*store, &id, Default::default()).await.unwrap();
        assert_eq!(format!("{:?}", closed.state), "Closed");
        let err = join_room(&*store, &id, participant("bob"), Default::default())
            .await
            .unwrap_err();
        assert_eq!(err.code, "room_closed");
        let delivery = handle_signal(
            &*store,
            json!({"v": 1, "type": "chat", "roomId": id, "senderId": "alice", "sessionId": "session-alice",
                   "ts": 1, "seq": 1, "payload": {"text": "still here"}}),
        )
        .await
        .unwrap();
        assert_eq!(delivery.recipients.len(), 0);
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        join_room(&*store, &id, participant("bob"), Default::default())
            .await
            .unwrap();
        let result = leave_room(&*store, &id, "alice", Default::default())
            .await
            .unwrap();
        assert_eq!(
            result
                .participants
                .iter()
                .map(|p| p.participant_id.as_str())
                .collect::<Vec<_>>(),
            vec!["bob"]
        );
        assert!(store.get_participant(&id, "alice").await.unwrap().is_none());
        let err = leave_room(&*store, &id, "alice", Default::default())
            .await
            .unwrap_err();
        assert_eq!(err.code, "participant_not_found");
        destroy(&h, store).await;
    }

    // ---- signals ---------------------------------------------------------
    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let s1 = store
            .put_signal(crate::store::SignalInput {
                room_id: id.clone(),
                envelope: create_envelope("chat", &id, "alice", "s", Some(json!({"text": "one"}))),
                received_at: 1,
            })
            .await
            .unwrap();
        let s2 = store
            .put_signal(crate::store::SignalInput {
                room_id: id.clone(),
                envelope: create_envelope("chat", &id, "alice", "s", Some(json!({"text": "two"}))),
                received_at: 2,
            })
            .await
            .unwrap();
        let s3 = store
            .put_signal(crate::store::SignalInput {
                room_id: id.clone(),
                envelope: create_envelope(
                    "chat",
                    &id,
                    "alice",
                    "s",
                    Some(json!({"text": "three"})),
                ),
                received_at: 3,
            })
            .await
            .unwrap();
        assert!(s1.seq < s2.seq && s2.seq < s3.seq);
        let after = store.list_signals(&id, s2.seq).await.unwrap();
        assert_eq!(
            after.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![s3.seq]
        );
        let all = store.list_signals(&id, 0).await.unwrap();
        assert_eq!(all.len(), 3);
        // Envelope JSON round-trips verbatim through the store.
        assert_eq!(all[1].envelope, s2.envelope);
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        join_room(&*store, &id, participant("bob"), Default::default())
            .await
            .unwrap();
        join_room(&*store, &id, participant("carol"), Default::default())
            .await
            .unwrap();

        let offer = handle_signal(
            &*store,
            json!({"v": 1, "type": "offer", "roomId": id, "senderId": "alice", "sessionId": "session-alice",
                   "targetSenderId": "carol", "ts": 1, "seq": 1, "payload": {"sdp": "v=0\r\n"}}),
        )
        .await
        .unwrap();
        assert_eq!(
            offer
                .recipients
                .iter()
                .map(|p| p.participant_id.as_str())
                .collect::<Vec<_>>(),
            vec!["carol"]
        );

        let broadcast = handle_signal(
            &*store,
            json!({"v": 1, "type": "presence", "roomId": id, "senderId": "bob", "sessionId": "session-bob",
                   "ts": 1, "seq": 1, "payload": {"state": "online"}}),
        )
        .await
        .unwrap();
        let mut got: Vec<&str> = broadcast
            .recipients
            .iter()
            .map(|p| p.participant_id.as_str())
            .collect();
        got.sort_unstable();
        assert_eq!(got, vec!["alice", "bob", "carol"]);
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let err = handle_signal(
            &*store,
            json!({"v": 1, "type": "chat", "roomId": id, "senderId": "eve", "sessionId": "session-eve",
                   "ts": 1, "seq": 1, "payload": {"text": "hi"}}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "participant_not_found");
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let err = handle_signal(&*store, json!({"not": "an envelope"}))
            .await
            .unwrap_err();
        assert_eq!(err.code, "invalid_envelope");
        destroy(&h, store).await;
    }

    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let join = join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        handle_signal(
            &*store,
            json!({"v": 1, "type": "reaction", "roomId": id, "senderId": "alice", "sessionId": "session-alice",
                   "ts": 1, "seq": 1, "payload": {"emoji": "👋"}}),
        )
        .await
        .unwrap();
        let updated = store.get_participant(&id, "alice").await.unwrap().unwrap();
        assert!(updated.last_seen_at >= join.participant.last_seen_at);
        destroy(&h, store).await;
    }

    // ---- recordings ------------------------------------------------------
    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let rec = start_recording(
            &*store,
            &id,
            crate::core::StartRecordingOptions {
                metadata: Some(json!({"mime": "video/webm"})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(format!("{:?}", rec.status), "Recording");
        assert_eq!(rec.room_id, id);
        let list = store.list_recordings(&id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].metadata, Some(json!({"mime": "video/webm"})));
        let fetched = store
            .get_recording(&rec.session_id)
            .await
            .unwrap()
            .expect("recording");
        assert_eq!(fetched.session_id, rec.session_id);
        let stopped = stop_recording(&*store, &rec.session_id, Default::default())
            .await
            .unwrap();
        assert_eq!(format!("{:?}", stopped.status), "Finalized");
        assert!(stopped.stopped_at.unwrap() >= stopped.started_at);
        let by_id = store.get_recording(&rec.session_id).await.unwrap().unwrap();
        assert_eq!(format!("{:?}", by_id.status), "Finalized");
        let err = stop_recording(&*store, "missing", Default::default())
            .await
            .unwrap_err();
        assert_eq!(err.code, "recording_not_found");
        destroy(&h, store).await;
    }

    // ---- state -----------------------------------------------------------
    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        handle_signal(
            &*store,
            json!({"v": 1, "type": "chat", "roomId": id, "senderId": "alice", "sessionId": "session-alice",
                   "ts": 1, "seq": 1, "payload": {"text": "x"}}),
        )
        .await
        .unwrap();
        let state = get_room_state(&*store, &id).await.unwrap();
        assert_eq!(state.room.room_id, id);
        assert_eq!(state.participants.len(), 1);
        assert!(state.signal_count >= 1);
        destroy(&h, store).await;
    }

    // ---- deleteRoom (when supported) -------------------------------------
    {
        let store = fresh(&h).await;
        let id = room_id(&prefix, name);
        create_room(
            &*store,
            crate::core::CreateRoomOptions {
                room_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        join_room(&*store, &id, participant("alice"), Default::default())
            .await
            .unwrap();
        let rec = start_recording(&*store, &id, Default::default())
            .await
            .unwrap();
        store
            .put_signal(crate::store::SignalInput {
                room_id: id.clone(),
                envelope: create_envelope(
                    "chat",
                    &id,
                    "alice",
                    "session-alice",
                    Some(json!({"text": "x"})),
                ),
                received_at: 1,
            })
            .await
            .unwrap();
        let _ = rec;
        store.delete_room(&id).await.unwrap();
        assert!(store.get_room(&id).await.unwrap().is_none());
        assert_eq!(store.list_participants(&id).await.unwrap().len(), 0);
        assert_eq!(store.list_signals(&id, 0).await.unwrap().len(), 0);
        assert_eq!(store.list_recordings(&id).await.unwrap().len(), 0);
        assert!(store
            .get_recording(&rec.session_id)
            .await
            .unwrap()
            .is_none());
        destroy(&h, store).await;
    }
}

async fn fresh(h: &StoreHarness) -> Box<dyn Store> {
    (h.create_store)().await.expect("create_store failed")
}

async fn destroy(h: &StoreHarness, store: Box<dyn Store>) {
    if let Some(d) = &h.destroy_store {
        d(store).await;
    }
}

/// Assert helper usable from tests: check a VidcallError code.
pub fn assert_error_code(err: &VidcallError, code: &str) {
    assert_eq!(err.code, code, "unexpected error: {err:?}");
}
