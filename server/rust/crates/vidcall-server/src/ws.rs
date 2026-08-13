//! WebSocket signaling relay — mirror of `packages/server/src/ws.ts`.
//!
//! Upgrades `GET {prefix}/ws?roomId=...&token=...` connections on the axum
//! router and relays protocol envelopes between room members:
//!
//!  1. Client connects to `/ws?roomId=<id>` (auth mode: `?token=<token>`)
//!     and sends a `join` envelope.
//!  2. The relay registers the participant (core [`join_room`]), replies with
//!     a server-only `{ "type": "joined", "room", "participants" }` message,
//!     and broadcasts the join envelope to the room.
//!  3. Every further envelope (`offer`/`answer`/`ice`/`presence`/`reaction`/
//!     `chat`/...) is persisted (core [`handle_signal`]) and relayed to the
//!     other members — the sender never receives its own signal back.
//!  4. A `leave` envelope (or a dropped connection) removes the participant
//!     and broadcasts the leave to the remaining members.
//!
//! [`RoomHub`] doubles as the in-process relay hub, so REST mutations (HTTP
//! join/leave/signal) fan out to the same connected sockets.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;

use crate::auth::verify_token;
use crate::core::{
    build_leave_envelope, handle_signal_envelope, join_room, leave_room, ParticipantInput,
};
use crate::error::{Result, VidcallError};
use crate::http::AppState;
use crate::protocol::{create_envelope, Envelope};
use crate::types::Participant;

/// One fan-out message on a room channel: the serialized envelope plus the
/// sender id (so each socket can skip its own echoes) and the recipient set
/// computed by the core relay (`core::handle_signal_envelope`).
#[derive(Debug, Clone)]
pub struct BroadcastMsg {
    pub envelope_json: String,
    pub sender_id: String,
    /// When `Some`, only sockets whose sender id is in this set receive the
    /// message (peer-addressed envelopes, `targetSenderId`); when `None`,
    /// every socket except the envelope's sender receives it.
    pub recipients: Option<std::collections::HashSet<String>>,
}

/// Room → connected sockets registry; implements the relay hub.
pub struct RoomHub {
    rooms: Mutex<HashMap<String, broadcast::Sender<Arc<BroadcastMsg>>>>,
    members: Mutex<HashMap<String, HashMap<u64, String>>>,
    next_socket_id: AtomicU64,
}

/// Default fan-out channel capacity.
const HUB_CAPACITY: usize = 512;

impl RoomHub {
    /// Create an empty hub.
    pub fn new() -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
            members: Mutex::new(HashMap::new()),
            next_socket_id: AtomicU64::new(1),
        }
    }

    /// Subscribe to a room's fan-out channel.
    pub fn subscribe(&self, room_id: &str) -> broadcast::Receiver<Arc<BroadcastMsg>> {
        let mut rooms = self.rooms.lock().unwrap();
        let tx = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| broadcast::channel(HUB_CAPACITY).0)
            .clone();
        tx.subscribe()
    }

    /// Allocate a socket id and register the socket's sender id in a room.
    pub fn attach(&self, room_id: &str, sender_id: &str) -> u64 {
        let id = self.next_socket_id.fetch_add(1, Ordering::SeqCst);
        self.members
            .lock()
            .unwrap()
            .entry(room_id.to_string())
            .or_default()
            .insert(id, sender_id.to_string());
        id
    }

    /// Remove a socket from a room's registry.
    pub fn detach(&self, room_id: &str, socket_id: u64) {
        let mut members = self.members.lock().unwrap();
        if let Some(room) = members.get_mut(room_id) {
            room.remove(&socket_id);
            if room.is_empty() {
                members.remove(room_id);
                self.rooms.lock().unwrap().remove(room_id);
            }
        }
    }

    /// Broadcast a serialized envelope on the room channel. `recipients` is
    /// the delivery set computed by the core relay: `None` fans out to every
    /// socket except the envelope's sender (join/leave/presence and untargeted
    /// signals), `Some(set)` restricts delivery to those participant ids
    /// (peer-addressed envelopes via `targetSenderId`).
    pub fn broadcast(
        &self,
        room_id: &str,
        envelope: &Envelope,
        recipients: Option<&std::collections::HashSet<String>>,
    ) {
        let msg = Arc::new(BroadcastMsg {
            envelope_json: serde_json::to_string(envelope).unwrap_or_else(|_| "{}".to_string()),
            sender_id: envelope.sender_id.clone(),
            recipients: recipients.cloned(),
        });
        let rooms = self.rooms.lock().unwrap();
        if let Some(tx) = rooms.get(room_id) {
            let _ = tx.send(msg);
        }
    }

    /// Number of connected clients for a room (diagnostics/tests).
    pub fn client_count(&self, room_id: &str) -> usize {
        self.members
            .lock()
            .unwrap()
            .get(room_id)
            .map(|m| m.len())
            .unwrap_or(0)
    }
}

impl Default for RoomHub {
    fn default() -> Self {
        Self::new()
    }
}

/// WS query params: `?roomId=<id>&userId=<id>&token=<token>`.
#[derive(Debug, Clone, Default)]
pub struct WsParams {
    pub room_id: String,
    pub user_id: Option<String>,
    /// HMAC token (auth mode); verified when the client sends its `join`
    /// envelope, mirroring the TS sibling (`?token=` on the upgrade URL).
    pub token: Option<String>,
}

/// Upgrade handler mounted at `{prefix}/ws`.
///
/// Query params are parsed manually (not via `Query<WsParams>`) so a
/// missing `roomId` produces the standard JSON `invalid_request` envelope
/// instead of axum's plain-text query rejection.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<Arc<AppState>>,
) -> Result<Response> {
    let params = WsParams {
        room_id: params.get("roomId").cloned().unwrap_or_default(),
        user_id: params.get("userId").cloned(),
        token: params.get("token").cloned(),
    };
    if params.room_id.is_empty() {
        return Err(VidcallError::invalid_request("Missing query param: roomId"));
    }
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state, params)))
}

/// Server-only message sent to a client right after a successful join.
#[derive(Debug, serde::Serialize)]
struct JoinedMessage {
    r#type: &'static str,
    room_id: String,
    room: crate::types::Room,
    participants: Vec<Participant>,
}

fn error_envelope(room_id: &str, code: &str, message: &str) -> Envelope {
    create_envelope(
        "error",
        room_id,
        "server",
        "server",
        Some(serde_json::json!({ "code": code, "message": message })),
    )
}

fn err_code(err: &VidcallError) -> &'static str {
    err.code
}

/// Participant-id set for [`RoomHub::broadcast`] delivery filtering.
pub(crate) fn recipient_ids(participants: &[Participant]) -> std::collections::HashSet<String> {
    participants
        .iter()
        .map(|p| p.participant_id.clone())
        .collect()
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, params: WsParams) {
    let room_id = params.room_id.clone();
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Outbound channel: every message the socket receives goes through this
    // (text frames + the 4401 close used by auth failures).
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<OutMsg>();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let frame = match msg {
                OutMsg::Text(text) => Message::Text(text.into()),
                OutMsg::Close(code, reason) => {
                    let _ = ws_sender
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            };
            if ws_sender.send(frame).await.is_err() {
                break;
            }
        }
    });

    // Relay subscription: join the room's fan-out channel.
    let mut relay_rx = state.hub.subscribe(&room_id);

    // Socket metadata: bound once a join envelope is accepted.
    let mut my_sender_id: Option<String> = None;
    let mut my_session_id: Option<String> = None;
    let mut socket_id: Option<u64> = None;
    let mut joined = false;

    loop {
        tokio::select! {
            incoming = ws_receiver.next() => {
                match incoming {
                    Some(Ok(msg)) => {
                        let handled = handle_message(
                            &state, &out_tx, &room_id, params.token.clone(),
                            &mut my_sender_id, &mut my_session_id, &mut socket_id, &mut joined,
                            msg,
                        ).await;
                        match handled {
                            Ok(true) => {}
                            Ok(false) => break,   // auth failure: socket closed with 4401
                            Err(_) => break,      // fatal protocol violation
                        }
                    }
                    _ => break, // socket closed
                }
            }
            relayed = relay_rx.recv() => {
                match relayed {
                    Ok(msg) => {
                        // Peer-addressed envelopes reach only their target;
                        // everything else fans out to the whole room. Either
                        // way the envelope's own sender never gets an echo.
                        let targeted = msg
                            .recipients
                            .as_ref()
                            .map(|recips| {
                                my_sender_id
                                    .as_deref()
                                    .map(|id| recips.contains(id))
                                    .unwrap_or(false)
                            })
                            .unwrap_or(true);
                        if targeted && my_sender_id.as_deref() != Some(msg.sender_id.as_str()) {
                            let _ = out_tx.send(OutMsg::Text(msg.envelope_json.clone()));
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        }
    }

    // Cleanup: auto-leave with reason "disconnect".
    if joined {
        if let (Some(sender_id), Some(session_id)) = (my_sender_id.clone(), my_session_id.clone()) {
            let participant = state
                .store
                .get_participant(&room_id, &sender_id)
                .await
                .ok()
                .flatten();
            let envelope = participant
                .as_ref()
                .map(|p| build_leave_envelope(&room_id, p, Some("disconnect")));
            let _ = leave_room(
                &*state.store,
                &room_id,
                &sender_id,
                crate::core::LeaveRoomOptions {
                    envelope: envelope.clone(),
                    ..Default::default()
                },
            )
            .await;
            if let Some(id) = socket_id {
                state.hub.detach(&room_id, id);
            }
            if let Some(env) = &envelope {
                state.hub.broadcast(&room_id, env, None);
            }
            let _ = session_id;
        }
    } else if let Some(id) = socket_id {
        state.hub.detach(&room_id, id);
    }

    let _ = send_task.await;
}

/// One outbound frame (text envelope or a close with a code).
enum OutMsg {
    Text(String),
    Close(u16, String),
}

fn send(out_tx: &tokio::sync::mpsc::UnboundedSender<OutMsg>, envelope: &Envelope) {
    let json = serde_json::to_string(envelope).unwrap_or_else(|_| "{}".to_string());
    let _ = out_tx.send(OutMsg::Text(json));
}

fn send_close(out_tx: &tokio::sync::mpsc::UnboundedSender<OutMsg>, code: u16, reason: &str) {
    let _ = out_tx.send(OutMsg::Close(code, reason.to_string()));
}

/// Handle one inbound message. Returns `Ok(true)` when the socket should
/// keep running, `Ok(false)` when the connection was closed deliberately
/// (auth failure → error envelope + 4401 close), and `Err` on fatal
/// protocol violations (socket drop).
async fn handle_message(
    state: &Arc<AppState>,
    out_tx: &tokio::sync::mpsc::UnboundedSender<OutMsg>,
    room_id: &str,
    token: Option<String>,
    my_sender_id: &mut Option<String>,
    my_session_id: &mut Option<String>,
    socket_id: &mut Option<u64>,
    joined: &mut bool,
    msg: Message,
) -> Result<bool> {
    let text = match msg {
        Message::Text(text) => text.to_string(),
        Message::Binary(bin) => String::from_utf8_lossy(&bin).to_string(),
        Message::Close(_) => return Ok(false),
        _ => return Ok(true),
    };

    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            send(
                out_tx,
                &error_envelope("unknown", "invalid_json", "Message is not valid JSON"),
            );
            return Ok(true);
        }
    };
    let envelope = match crate::protocol::envelope_from_value(parsed.clone()) {
        Some(e) => e,
        None => {
            let rid = parsed
                .get("roomId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            send(
                out_tx,
                &error_envelope(
                    rid,
                    "invalid_envelope",
                    "Envelope failed protocol validation",
                ),
            );
            return Ok(true);
        }
    };

    if !*joined {
        // First message must be a join for the room the client connected with.
        if envelope.r#type != "join" {
            send(
                out_tx,
                &error_envelope(&envelope.room_id, "must_join", "Send a join envelope first"),
            );
            return Ok(true);
        }
        return handle_join(
            state,
            out_tx,
            room_id,
            token,
            my_sender_id,
            my_session_id,
            socket_id,
            joined,
            envelope,
        )
        .await;
    }

    if envelope.room_id != room_id {
        send(
            out_tx,
            &error_envelope(
                &envelope.room_id,
                "room_mismatch",
                &format!("Socket is bound to room {room_id}"),
            ),
        );
        return Ok(true);
    }

    if envelope.r#type == "leave" {
        let leave_envelope = envelope.clone();
        let sender_id = leave_envelope.sender_id.clone();
        let leave_room_id = leave_envelope.room_id.clone();
        let result = leave_room(
            &*state.store,
            &leave_room_id,
            &sender_id,
            crate::core::LeaveRoomOptions {
                envelope: Some(leave_envelope),
                ..Default::default()
            },
        )
        .await;
        match result {
            Ok(result) => {
                if let Some(id) = socket_id.take() {
                    state.hub.detach(&room_id, id);
                }
                if let Some(delivery) = result.delivery {
                    state.hub.broadcast(
                        &room_id,
                        &delivery.envelope,
                        Some(&recipient_ids(&delivery.recipients)),
                    );
                }
                *joined = false;
            }
            Err(err) => {
                send(
                    out_tx,
                    &error_envelope(&room_id, err_code(&err), &err.message),
                );
            }
        }
        return Ok(true);
    }

    match handle_signal_envelope(&*state.store, envelope).await {
        Ok(delivery) => {
            state.hub.broadcast(
                &room_id,
                &delivery.envelope,
                Some(&recipient_ids(&delivery.recipients)),
            );
            Ok(true)
        }
        Err(err) => {
            send(
                out_tx,
                &error_envelope(&room_id, err_code(&err), &err.message),
            );
            Ok(true)
        }
    }
}

/// Verify the socket's `?token=` against the join target (auth mode only).
/// Mirrors the TS sibling's `authenticateSocket`: on failure the caller
/// sends an error envelope and closes the socket with 4401.
fn authenticate_socket(
    state: &AppState,
    token: Option<&str>,
    room_id: &str,
    sender_id: &str,
) -> Result<()> {
    let auth = match &state.auth {
        Some(auth) => auth,
        None => return Ok(()), // legacy open mode
    };
    let claims = verify_token(&auth.secret, token.unwrap_or(""))?;
    if claims.room_id != room_id {
        return Err(VidcallError::forbidden(format!(
            "Token is scoped to room {}, not {} (tokens are room-scoped)",
            claims.room_id, room_id
        )));
    }
    if claims.participant_id != sender_id {
        return Err(VidcallError::forbidden(format!(
            "Token is bound to participant {}, not {}",
            claims.participant_id, sender_id
        )));
    }
    Ok(())
}

/// Handle a join: authenticate (auth mode), register the participant,
/// persist the join envelope, attach the socket to the room hub.
///
/// Returns `Ok(true)` when the join succeeded, `Ok(false)` when the socket
/// was closed with 4401 (auth failure), and `Err` when the socket should be
/// dropped (fatal protocol error).
async fn handle_join(
    state: &Arc<AppState>,
    out_tx: &tokio::sync::mpsc::UnboundedSender<OutMsg>,
    room_id: &str,
    token: Option<String>,
    my_sender_id: &mut Option<String>,
    my_session_id: &mut Option<String>,
    socket_id: &mut Option<u64>,
    joined: &mut bool,
    envelope: Envelope,
) -> Result<bool> {
    // Auth mode: reject the join (error envelope + 4401 close) when the
    // `?token=` is missing/invalid, scoped to another room, or bound to
    // another sender.
    if let Err(err) = authenticate_socket(state, token.as_deref(), room_id, &envelope.sender_id) {
        send(
            out_tx,
            &error_envelope(room_id, err_code(&err), &err.message),
        );
        send_close(out_tx, 4401, err.code);
        return Ok(false);
    }
    let payload = envelope.payload.clone().unwrap_or(serde_json::Value::Null);
    let input = ParticipantInput {
        participant_id: envelope.sender_id.clone(),
        session_id: envelope.session_id.clone(),
        display_name: payload
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        metadata: payload.get("metadata").cloned().filter(|v| !v.is_null()),
    };
    match join_room(&*state.store, room_id, input.clone(), Default::default()).await {
        Ok(result) => {
            // Persist the join envelope into the signal log + compute recipients.
            let delivery = match handle_signal_envelope(&*state.store, envelope).await {
                Ok(d) => d,
                Err(err) => {
                    send(
                        out_tx,
                        &error_envelope(room_id, err_code(&err), &err.message),
                    );
                    return Ok(true);
                }
            };
            let id = state.hub.attach(room_id, &input.participant_id);
            *my_sender_id = Some(input.participant_id.clone());
            *my_session_id = Some(input.session_id.clone());
            *socket_id = Some(id);
            *joined = true;
            // Peers learn about the newcomer; the joiner gets the `joined` ack below.
            state.hub.broadcast(
                room_id,
                &delivery.envelope,
                Some(&recipient_ids(&delivery.recipients)),
            );
            let joined_msg = JoinedMessage {
                r#type: "joined",
                room_id: room_id.to_string(),
                room: result.room,
                participants: result.participants,
            };
            let json = serde_json::to_string(&joined_msg).unwrap_or_else(|_| "{}".to_string());
            let _ = out_tx.send(OutMsg::Text(json));
            Ok(true)
        }
        Err(err) => {
            send(
                out_tx,
                &error_envelope(room_id, err_code(&err), &err.message),
            );
            Ok(true)
        }
    }
}
