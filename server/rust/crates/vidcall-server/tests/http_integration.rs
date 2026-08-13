//! REST integration tests — the exact route surface of the TS sibling
//! (`packages/server/src/http.ts`), driven through axum's tower `oneshot`.
//!
//! These prove the *wire contract*: JSON envelopes, camelCase keys,
//! status codes and error shapes — what Django/Laravel/Rails proxies will
//! see.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

use vidcall_server::recording::DiskRecordingStorage;
use vidcall_server::stores::InMemoryStore;
use vidcall_server::{router, router_with_state};

/// One-shot request helper: returns (status, parsed JSON body).
async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri);
    let req = match body {
        Some(b) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.expect("router serves");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 8 * 1024 * 1024)
        .await
        .expect("read body");
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json body")
    };
    (status, value)
}

async fn post(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    send(app, Method::POST, uri, Some(body)).await
}

async fn get(app: &Router, uri: &str) -> (StatusCode, Value) {
    send(app, Method::GET, uri, None).await
}

fn error_code(body: &Value) -> String {
    body["error"]["code"].as_str().unwrap_or("?").to_string()
}

#[tokio::test]
async fn create_room_returns_camelcase_envelope() {
    let app = router(InMemoryStore::new());
    let (status, body) = post(&app, "/v1/rooms", json!({
        "roomId": "r-create-1",
        "maxParticipants": 4,
        "metadata": {"topic": "standup"},
    }))
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    // TS contract: `room.roomId` (camelCase on the wire).
    assert_eq!(body["room"]["roomId"], "r-create-1");
    assert_eq!(body["room"]["state"], "open");
    assert_eq!(body["room"]["maxParticipants"], 4);
    assert_eq!(body["room"]["metadata"]["topic"], "standup");
    assert!(body["room"]["createdAt"].as_i64().unwrap() > 0);
    assert!(body["room"]["updatedAt"].as_i64().unwrap() > 0);

    // Duplicate → 409 room_already_exists.
    let (status, body) = post(&app, "/v1/rooms", json!({"roomId": "r-create-1"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "room_already_exists");
}

#[tokio::test]
async fn server_generates_room_id_when_omitted() {
    let app = router(InMemoryStore::new());
    let (status, body) = post(&app, "/v1/rooms", json!({})).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["room"]["roomId"].as_str().expect("generated id");
    assert!(!id.is_empty(), "room id must be generated");
}

#[tokio::test]
async fn join_leave_and_state_round_trip() {
    let app = router(InMemoryStore::new());
    post(&app, "/v1/rooms", json!({"roomId": "r-jl-1"})).await;

    let (status, body) = post(&app, "/v1/rooms/r-jl-1/join", json!({
        "participantId": "alice",
        "sessionId": "sess-a",
        "displayName": "Alice",
        "metadata": {"avatar": "a.png"},
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["participant"]["participantId"], "alice");
    assert_eq!(body["participant"]["sessionId"], "sess-a");
    assert_eq!(body["participant"]["displayName"], "Alice");
    assert_eq!(body["participant"]["metadata"]["avatar"], "a.png");
    assert_eq!(body["participants"].as_array().unwrap().len(), 1);
    assert_eq!(body["room"]["roomId"], "r-jl-1");

    // Nested `{ participant: {...} }` shape is also accepted (TS parity).
    let (status, body) = post(&app, "/v1/rooms/r-jl-1/join", json!({
        "participant": {"participantId": "bob", "sessionId": "sess-b", "displayName": "Bob"},
    }))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["participants"].as_array().unwrap().len(), 2);

    // State snapshot: room + roster + signal count.
    let (status, body) = get(&app, "/v1/rooms/r-jl-1/state").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["room"]["roomId"], "r-jl-1");
    assert_eq!(body["signalCount"], 0);
    let names: Vec<&str> = body["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["participantId"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alice", "bob"]);

    // Leave.
    let (status, body) = post(&app, "/v1/rooms/r-jl-1/leave", json!({
        "participantId": "alice",
        "reason": "bye",
    }))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["participants"].as_array().unwrap().len(), 1);

    // Unknown room → 404.
    let (status, body) = get(&app, "/v1/rooms/nope/state").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "room_not_found");
}

#[tokio::test]
async fn signal_relay_persists_and_returns_seq() {
    let app = router(InMemoryStore::new());
    post(&app, "/v1/rooms", json!({"roomId": "r-sig-1"})).await;
    post(&app, "/v1/rooms/r-sig-1/join", json!({"participantId": "alice", "sessionId": "s-a"})).await;
    post(&app, "/v1/rooms/r-sig-1/join", json!({"participantId": "bob", "sessionId": "s-b"})).await;

    let (status, body) = post(&app, "/v1/rooms/r-sig-1/signal", json!({
        "v": 1, "type": "chat", "roomId": "r-sig-1", "senderId": "alice",
        "sessionId": "s-a", "ts": 1, "seq": 1, "payload": {"text": "hi bob"},
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(body["seq"].as_i64().unwrap() > 0);
    let relayed: Vec<&str> = body["relayedTo"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(relayed, vec!["bob"], "sender must not receive its own echo");

    // Peer-addressed envelope goes only to the target.
    let (_, body) = post(&app, "/v1/rooms/r-sig-1/signal", json!({
        "v": 1, "type": "offer", "roomId": "r-sig-1", "senderId": "bob",
        "sessionId": "s-b", "ts": 1, "seq": 1, "targetSenderId": "alice",
        "payload": {"sdp": "v=0"},
    }))
    .await;
    assert_eq!(body["relayedTo"].as_array().unwrap().len(), 1);
    assert_eq!(body["relayedTo"][0], "alice");

    // Non-member sender → 404 participant_not_found.
    let (status, body) = post(&app, "/v1/rooms/r-sig-1/signal", json!({
        "v": 1, "type": "chat", "roomId": "r-sig-1", "senderId": "eve",
        "sessionId": "s-e", "ts": 1, "seq": 1, "payload": {"text": "x"},
    }))
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "participant_not_found");

    // Garbage envelope → 400 invalid_envelope.
    let (status, body) = post(&app, "/v1/rooms/r-sig-1/signal", json!({"not": "an envelope"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "invalid_envelope");
}

#[tokio::test]
async fn malformed_json_is_400_invalid_request() {
    let app = router(InMemoryStore::new());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/v1/rooms")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(error_code(&body), "invalid_request");

    // Missing participantId on join → 400 invalid_request.
    let (status, body) = post(&app, "/v1/rooms/x/join", json!({"sessionId": "s"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "invalid_request");
}

#[tokio::test]
async fn capacity_and_closed_room_errors() {
    let app = router(InMemoryStore::new());
    post(&app, "/v1/rooms", json!({"roomId": "r-cap", "maxParticipants": 1})).await;
    post(&app, "/v1/rooms/r-cap/join", json!({"participantId": "a", "sessionId": "s"})).await;
    let (status, body) = post(&app, "/v1/rooms/r-cap/join", json!({"participantId": "b", "sessionId": "s"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "room_full");

    // Closed room rejects joins (the TS sibling has no REST close route —
    // closings come from the app backend via core, so we close through core).
    let store = InMemoryStore::new();
    vidcall_server::core::create_room(
        &store,
        vidcall_server::core::CreateRoomOptions {
            room_id: Some("r-closed".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    vidcall_server::core::close_room(&store, "r-closed", Default::default())
        .await
        .unwrap();
    let app2 = router(store);
    let (status, body) = post(&app2, "/v1/rooms/r-closed/join", json!({"participantId": "b", "sessionId": "s"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "room_closed");
}

#[tokio::test]
async fn recording_chunks_and_finalize() {
    let dir = tempfile::tempdir().unwrap();
    let store = InMemoryStore::new();
    vidcall_server::core::create_room(
        &store,
        vidcall_server::core::CreateRoomOptions {
            room_id: Some("r-rec".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // Start the recording through core (the TS sibling has no REST start
    // route — recordings begin from the app backend).
    let rec = vidcall_server::core::start_recording(&store, "r-rec", Default::default())
        .await
        .unwrap();
    let sid = rec.session_id.clone();
    drop(rec);

    let storage = DiskRecordingStorage::new(dir.path());
    let state = vidcall_server::http::AppState {
        store: std::sync::Arc::new(store),
        recording_storage: Some(std::sync::Arc::new(storage)),
        hub: std::sync::Arc::new(vidcall_server::ws::RoomHub::new()),
        auth: None,
    };
    let app = router_with_state("/v1", state);

    // Chunks upload raw bytes.
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/v1/recordings/{sid}/chunks?index=0"))
        .body(Body::from(vec![0u8, 1, 2, 3]))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED, "chunk upload");

    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/v1/recordings/{sid}/chunks?index=1"))
        .body(Body::from(vec![4u8, 5, 6]))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let (status, body) = post(&app, &format!("/v1/recordings/{sid}/finalize"), json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["storage"]["sessionId"], sid);
    assert_eq!(body["storage"]["chunks"], 2);
    assert_eq!(body["storage"]["bytes"], 7);
    assert_eq!(body["recording"]["status"], "finalized");
    assert_eq!(body["recording"]["roomId"], "r-rec");

    // Read back the assembled file from disk.
    let bytes = std::fs::read(dir.path().join(&sid).join("chunk-000000")).unwrap();
    assert_eq!(bytes, vec![0u8, 1, 2, 3]);
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(sid).join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["bytes"], 7);

    // Unknown session → 404.
    let (status, body) = post(&app, "/v1/recordings/ghost/finalize", json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "recording_not_found");
}
