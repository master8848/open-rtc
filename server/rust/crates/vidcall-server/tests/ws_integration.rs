//! WebSocket relay integration tests — mirror of `packages/server/ws.ts`
//! semantics, driven through a real listener + tokio-tungstenite clients.
//!
//! Covered:
//!  - join ack (`joined` with room + roster), join fan-out to peers,
//!  - envelope relay (chat/offer/ice) with no sender echo,
//!  - peer-addressed envelopes go only to the target,
//!  - explicit `leave` envelope + auto-leave on disconnect,
//!  - protocol violations (non-JSON, non-envelope, wrong first message),
//!  - REST mutations fan out to connected WS sockets (shared RoomHub).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use vidcall_server::stores::InMemoryStore;
use vidcall_server::{router, router_with_state};

const TIMEOUT: Duration = Duration::from_secs(5);

struct TestServer {
    addr: String,
    app_handle: tokio::task::JoinHandle<()>,
}

async fn spawn_server() -> TestServer {
    spawn_server_with_state(None).await
}

async fn spawn_server_with_state(
    state: Option<vidcall_server::http::AppState>,
) -> TestServer {
    let app = match state {
        Some(s) => router_with_state("/v1", s),
        None => router(InMemoryStore::new()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("server runs");
    });
    TestServer {
        addr: format!("127.0.0.1:{}", addr.port()),
        app_handle: handle,
    }
}

type WsClient = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Ensure the room exists via the REST API (join requires an existing
/// room, mirroring `requireRoom` in the TS sibling).
async fn ensure_room(server: &TestServer, room_id: &str) {
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/rooms", server.addr))
        .json(&json!({ "roomId": room_id }))
        .send()
        .await
        .expect("create room");
    // Creating an existing room is a 409 (`room_already_exists`), which is
    // fine here: `connect_and_join` runs this helper before every connection.
    assert!(
        resp.status() == reqwest::StatusCode::CREATED
            || resp.status() == reqwest::StatusCode::CONFLICT,
        "create room failed: {}",
        resp.status()
    );
}

/// Connect a WS client and wait for the `joined` ack.
async fn connect_and_join(server: &TestServer, room_id: &str, sender_id: &str) -> WsClient {
    ensure_room(server, room_id).await;
    let url = format!("ws://{}/v1/ws?roomId={room_id}", server.addr);
    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");
    ws.send(Message::Text(
        json!({
            "v": 1, "type": "join", "roomId": room_id, "senderId": sender_id,
            "sessionId": format!("session-{sender_id}"), "ts": 1, "seq": 1,
            "payload": {"displayName": sender_id},
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    // The joiner's first message is the `joined` ack.
    let joined = recv_json(&mut ws).await;
    assert_eq!(joined["type"], "joined", "expected joined ack, got: {joined}");
    assert_eq!(joined["room"]["roomId"], room_id);
    ws
}

async fn recv_json(ws: &mut WsClient) -> Value {
    tokio::time::timeout(TIMEOUT, ws.next())
        .await
        .expect("ws message timeout")
        .expect("ws stream alive")
        .expect("ws message ok")
        .into_text()
        .map(|t| serde_json::from_str(&t).expect("json message"))
        .expect("text message")
}

fn envelope(r#type: &str, room_id: &str, sender_id: &str, payload: Value) -> Value {
    json!({
        "v": 1, "type": r#type, "roomId": room_id, "senderId": sender_id,
        "sessionId": format!("session-{sender_id}"), "ts": 1, "seq": 1, "payload": payload,
    })
}

#[tokio::test]
async fn join_ack_and_peer_fanout_no_echo() {
    let server = spawn_server().await;
    let room = "ws-room-1";

    let mut alice = connect_and_join(&server, room, "alice").await;
    let mut bob = connect_and_join(&server, room, "bob").await;
    // Alice sees bob's join envelope broadcast.
    let join_b = recv_json(&mut alice).await;
    assert_eq!(join_b["type"], "join");
    assert_eq!(join_b["senderId"], "bob");

    // Bob sends chat; alice receives it; bob does NOT get his own echo.
    bob.send(Message::Text(
        envelope("chat", room, "bob", json!({"text": "hello alice"}))
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let chat = recv_json(&mut alice).await;
    assert_eq!(chat["type"], "chat");
    assert_eq!(chat["senderId"], "bob");
    assert_eq!(chat["payload"]["text"], "hello alice");

    // Give the echo a chance to (wrongly) arrive, then assert none did.
    match tokio::time::timeout(Duration::from_millis(250), bob.next()).await {
        Err(_) => {} // timeout = no echo ✓
        Ok(Some(Ok(msg))) => panic!("bob received his own echo: {msg:?}"),
        Ok(_) => panic!("bob's stream closed unexpectedly"),
    }
    server.app_handle.abort();
}

#[tokio::test]
async fn peer_addressed_and_presence_broadcast() {
    let server = spawn_server().await;
    let room = "ws-room-2";

    let mut alice = connect_and_join(&server, room, "alice").await;
    let mut bob = connect_and_join(&server, room, "bob").await;
    let mut carol = connect_and_join(&server, room, "carol").await;
    // Drain the join broadcasts queued for each client. Alice was present
    // for bob's and carol's joins; bob was present for carol's join; carol
    // joined last, so nothing is queued on her socket.
    let _ = recv_json(&mut alice).await; // bob's join
    let _ = recv_json(&mut alice).await; // carol's join
    let _ = recv_json(&mut bob).await; // carol's join

    // Alice → carol offer: only carol receives it.
    let mut offer = envelope("offer", room, "alice", json!({"sdp": "v=0"}));
    offer["targetSenderId"] = json!("carol");
    bob.send(Message::Text(offer.to_string().into())).await.unwrap();

    // carol receives the offer; alice and bob must not.
    let got = recv_json(&mut carol).await;
    assert_eq!(got["type"], "offer");
    assert_eq!(got["senderId"], "alice");
    match tokio::time::timeout(Duration::from_millis(250), alice.next()).await {
        Err(_) => {}
        Ok(Some(Ok(m))) => panic!("alice received peer-addressed offer: {m:?}"),
        Ok(_) => panic!("alice stream closed"),
    }
    match tokio::time::timeout(Duration::from_millis(250), bob.next()).await {
        Err(_) => {}
        Ok(Some(Ok(m))) => panic!("bob received peer-addressed offer: {m:?}"),
        Ok(_) => panic!("bob stream closed"),
    }

    // Presence broadcasts to everyone (sender included).
    alice
        .send(Message::Text(
            envelope("presence", room, "alice", json!({"state": "online"}))
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(recv_json(&mut bob).await["type"], "presence");
    assert_eq!(recv_json(&mut carol).await["type"], "presence");
    server.app_handle.abort();
}

#[tokio::test]
async fn explicit_leave_and_disconnect_auto_leave() {
    let server = spawn_server().await;
    let room = "ws-room-3";

    let mut alice = connect_and_join(&server, room, "alice").await;
    let mut bob = connect_and_join(&server, room, "bob").await;
    let _ = recv_json(&mut alice).await; // bob's join (bob connected after alice)

    // Bob leaves explicitly (reason travels in the leave payload).
    bob.send(Message::Text(
        envelope("leave", room, "bob", json!({"reason": "bye"})).to_string().into(),
    ))
    .await
    .unwrap();
    let leave = recv_json(&mut alice).await;
    assert_eq!(leave["type"], "leave");
    assert_eq!(leave["senderId"], "bob");
    assert_eq!(leave["payload"]["reason"], "bye");

    // Alice disconnects abruptly → bob sees an auto-leave. bob2 connects
    // after alice2 joined, so the disconnect leave is the first message his
    // socket receives.
    let mut alice2 = connect_and_join(&server, room, "alice2").await;
    let mut bob2 = connect_and_join(&server, room, "bob2").await;
    let _ = recv_json(&mut alice2).await; // bob2's join
    alice2.close(None).await.unwrap();
    let leave2 = recv_json(&mut bob2).await;
    assert_eq!(leave2["type"], "leave");
    assert_eq!(leave2["senderId"], "alice2");
    assert_eq!(leave2["payload"]["reason"], "disconnect");
    server.app_handle.abort();
}

#[tokio::test]
async fn protocol_violations_get_error_envelopes() {
    let server = spawn_server().await;
    let room = "ws-room-4";

    // The protocol-violation errors are pre-join, but the final join needs
    // the room to exist (joins require an existing room, `requireRoom`).
    ensure_room(&server, room).await;

    let url = format!("ws://{}/v1/ws?roomId={room}", server.addr);
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Not JSON.
    ws.send(Message::Text("garbage".into())).await.unwrap();
    let err = recv_json(&mut ws).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["payload"]["code"], "invalid_json");

    // Valid JSON but not an envelope.
    ws.send(Message::Text(json!({"hello": 1}).to_string().into()))
        .await
        .unwrap();
    let err = recv_json(&mut ws).await;
    assert_eq!(err["payload"]["code"], "invalid_envelope");

    // Envelope but not a join → must join first.
    ws.send(Message::Text(
        envelope("chat", room, "eve", json!({"text": "hi"}))
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let err = recv_json(&mut ws).await;
    assert_eq!(err["payload"]["code"], "must_join");

    // Then a proper join works and the ack arrives.
    ws.send(Message::Text(
        envelope("join", room, "eve", json!({"displayName": "Eve"}))
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let joined = recv_json(&mut ws).await;
    assert_eq!(joined["type"], "joined");
    server.app_handle.abort();
}

#[tokio::test]
async fn missing_room_id_is_400() {
    let server = spawn_server().await;
    // A WS upgrade without roomId → 400 JSON `invalid_request` (the upgrade
    // is rejected before the handshake completes, mirroring `requireRoom`
    // semantics at the HTTP layer).
    let url = format!("ws://{}/v1/ws", server.addr);
    let err = tokio_tungstenite::connect_async(&url).await.unwrap_err();
    match err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);
            let raw = resp.body().as_deref().unwrap_or_default();
            let body: Value =
                serde_json::from_slice(raw).expect("400 body is the JSON error envelope");
            assert_eq!(body["error"]["code"], "invalid_request");
        }
        other => panic!("expected an HTTP rejection, got: {other}"),
    }
    server.app_handle.abort();
}

#[tokio::test]
async fn rest_mutations_fan_out_to_ws_sockets() {
    // Build a router whose hub is shared with the WS layer (the default
    // router does this internally: one AppState, one RoomHub).
    let server = spawn_server().await;
    let room = "ws-rest-1";

    let mut alice = connect_and_join(&server, room, "alice").await;

    // Bob joins via REST → alice's socket receives the join envelope.
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/rooms/{room}/join", server.addr))
        .json(&json!({"participantId": "bob", "sessionId": "s-b", "displayName": "Bob"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let join = recv_json(&mut alice).await;
    assert_eq!(join["type"], "join");
    assert_eq!(join["senderId"], "bob");

    // REST signal from bob → alice receives it over the socket.
    client
        .post(format!("http://{}/v1/rooms/{room}/signal", server.addr))
        .json(&envelope("chat", room, "bob", json!({"text": "via rest"})))
        .send()
        .await
        .unwrap();
    let chat = recv_json(&mut alice).await;
    assert_eq!(chat["type"], "chat");
    assert_eq!(chat["senderId"], "bob");
    assert_eq!(chat["payload"]["text"], "via rest");

    // REST leave from bob → alice receives the leave.
    client
        .post(format!("http://{}/v1/rooms/{room}/leave", server.addr))
        .json(&json!({"participantId": "bob", "reason": "bye"}))
        .send()
        .await
        .unwrap();
    let leave = recv_json(&mut alice).await;
    assert_eq!(leave["type"], "leave");
    assert_eq!(leave["senderId"], "bob");
    server.app_handle.abort();
}
