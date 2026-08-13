//! Framework-agnostic REST handlers + axum [`Router`].
//!
//! `router(store)` is the single router every hosting layer shares: the
//! standalone sidecar binary here, or any Rust app via `Router::merge`.
//! Django/Laravel/Rails attach via a reverse proxy (see
//! `integrations/ATTACH.md`).
//!
//! Endpoints (JSON envelope per protocol/schema.json), mirroring
//! `packages/server/src/http.ts`:
//!  - `POST   /v1/auth/token`               issue a room-scoped token (auth mode)
//!  - `POST   /v1/rooms`                    create a room
//!  - `POST   /v1/rooms/:id/join`           join a room (adds participant)
//!  - `POST   /v1/rooms/:id/leave`          leave a room
//!  - `POST   /v1/rooms/:id/signal`         relay one protocol envelope
//!  - `POST   /v1/rooms/:id/close`          close a room (admin only)
//!  - `DELETE /v1/rooms/:id`                delete a room (admin only)
//!  - `GET    /v1/rooms/:id/state`          room + participant roster
//!  - `GET    /v1/rooms/:id/recordings`     recording sessions
//!  - `POST   /v1/recordings/:sessionId/chunks`   upload one media chunk (raw body)
//!  - `POST   /v1/recordings/:sessionId/finalize` seal a recording session
//!  - `WS     /v1/ws?roomId=&userId=&token=` live envelope relay
//!
//! Auth (see [`crate::auth`]): when `AppState.auth` is set, join/leave/
//! signal/state/recordings/close/delete require `Authorization: Bearer
//! <token>`; tokens are HMAC-signed, room-scoped, and identity-bound.
//! Without auth the server runs in legacy open mode (dev-only).

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use bytes::Bytes;
use serde::{Deserialize, de::DeserializeOwned};

use crate::auth::{issue_token, verify_token, TokenClaims, TokenRole, DEFAULT_TOKEN_TTL_SECONDS};
use crate::core::{
    build_join_envelope, build_leave_envelope, close_room, create_room, get_recordings,
    get_room_state, handle_signal, join_room, leave_room, stop_recording, CreateRoomOptions,
    JoinRoomOptions, ParticipantInput,
};
use crate::error::{Result, VidcallError};
use crate::protocol::now_ms;
use crate::recording::RecordingStorage;
use crate::store::Store;
use crate::types::RoomSnapshot;
use crate::ws::RoomHub;

/// Default route prefix for the REST + WS routes.
pub const DEFAULT_ROUTE_PREFIX: &str = "/v1";

/// HMAC auth configuration (mirrors `Services.auth` in the TS sibling).
///
/// When `secret` is set, room-scoped routes require a token issued by
/// [`issue_token`] / `POST /auth/token`; when absent, the server runs in
/// legacy open mode.
#[derive(Debug, Clone, Default)]
pub struct AuthConfig {
    /// HMAC-SHA256 signing key. Never ship this to clients.
    pub secret: String,
    /// Optional shared secret for `POST /auth/token`. When set, token
    /// issuance requires an `adminToken` header; `role: "admin"` always
    /// requires it. When unset, the token endpoint is open (participant
    /// tokens only).
    pub admin_token: Option<String>,
    /// Lifetime for tokens minted by `/auth/token` without an explicit
    /// `exp`; default 1 hour.
    pub default_token_ttl_ms: Option<i64>,
}

/// Everything a handler needs, shared via axum state.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn Store>,
    /// Optional recording byte storage; without it, recording routes 500
    /// with `recording_storage_error` (mirrors the TS sibling).
    pub recording_storage: Option<Arc<dyn RecordingStorage>>,
    /// In-process WS relay hub; HTTP mutations fan out to connected sockets.
    pub hub: Arc<RoomHub>,
    /// Optional HMAC auth; when set, room routes require tokens.
    pub auth: Option<AuthConfig>,
}

/// Build the full API [`Router`] under [`DEFAULT_ROUTE_PREFIX`] (`/v1`).
///
/// Merge into an existing axum app:
/// ```
/// use vidcall_server::{router, stores::InMemoryStore};
/// # async fn example() {
/// let app = axum::Router::new()
///     .merge(vidcall_server::router(InMemoryStore::new()));
/// # let _ = app;
/// # }
/// ```
pub fn router<S: Store>(store: S) -> Router {
    router_at(DEFAULT_ROUTE_PREFIX, store)
}

/// Build the API [`Router`] under an explicit prefix (e.g. `/vidcall`).
/// Pass the prefix without a trailing slash; the WS route is
/// `{prefix}/ws`.
pub fn router_at<S: Store>(prefix: &str, store: S) -> Router {
    let prefix = prefix.trim_end_matches('/').to_string();
    let state = Arc::new(AppState {
        store: Arc::new(store),
        recording_storage: None,
        hub: Arc::new(RoomHub::new()),
        auth: None,
    });
    build_router(&prefix, state)
}

/// Like [`router_at`], but with an explicit [`AppState`] (recording storage,
/// relay hub and auth included).
pub fn router_with_state(prefix: &str, state: AppState) -> Router {
    let prefix = prefix.trim_end_matches('/').to_string();
    build_router(&prefix, Arc::new(state))
}

fn build_router(prefix: &str, state: Arc<AppState>) -> Router {
    // Wrong method on a known path returns the same JSON 404 as the TS
    // sibling's `dispatch` (its `matchRoute` checks method + pattern).
    let fallback = not_found_handler;
    Router::new()
        .route(&format!("{prefix}/auth/token"), post(auth_token_handler))
        .route(&format!("{prefix}/rooms"), post(create_room_handler))
        .route(&format!("{prefix}/rooms/{{room_id}}/join"), post(join_handler).fallback(fallback))
        .route(&format!("{prefix}/rooms/{{room_id}}/leave"), post(leave_handler).fallback(fallback))
        .route(&format!("{prefix}/rooms/{{room_id}}/signal"), post(signal_handler).fallback(fallback))
        .route(&format!("{prefix}/rooms/{{room_id}}/close"), post(close_room_handler).fallback(fallback))
        .route(&format!("{prefix}/rooms/{{room_id}}"), delete(delete_room_handler).fallback(fallback))
        .route(&format!("{prefix}/rooms/{{room_id}}/state"), get(state_handler).fallback(fallback))
        .route(&format!("{prefix}/rooms/{{room_id}}/recordings"), get(recordings_handler).fallback(fallback))
        .route(&format!("{prefix}/recordings/{{session_id}}/chunks"), post(chunks_handler).fallback(fallback))
        .route(&format!("{prefix}/recordings/{{session_id}}/finalize"), post(finalize_handler).fallback(fallback))
        .route(&format!("{prefix}/ws"), get(crate::ws::ws_handler))
        .route(&format!("{prefix}/{{*path}}"), axum::routing::any(not_found_handler))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Request bodies (mirror the TS sibling's accepted shapes)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomBody {
    room_id: Option<String>,
    max_participants: Option<u32>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinBody {
    participant_id: Option<String>,
    session_id: Option<String>,
    display_name: Option<String>,
    metadata: Option<serde_json::Value>,
    /// Alternative nested shape: `{ "participant": { participantId, ... } }`.
    participant: Option<JoinBodyParticipant>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinBodyParticipant {
    participant_id: Option<String>,
    session_id: Option<String>,
    display_name: Option<String>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaveBody {
    participant_id: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthTokenBody {
    room_id: Option<String>,
    participant_id: Option<String>,
    role: Option<String>,
    exp: Option<i64>,
}

// ---------------------------------------------------------------------------
// Auth guards (no-op in legacy open mode — no `AppState.auth`)
// ---------------------------------------------------------------------------

/// Extract the bearer token from an `Authorization` header.
fn bearer_token(headers: &HeaderMap) -> Result<String> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let Some(header) = header else {
        return Err(VidcallError::unauthorized(
            "Missing Authorization header (Bearer <token>)",
        ));
    };
    let trimmed = header.trim();
    let lower = trimmed.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("bearer ") else {
        return Err(VidcallError::unauthorized(
            "Authorization header must use the Bearer scheme",
        ));
    };
    let token = trimmed[trimmed.len() - rest.len()..].trim().to_string();
    if token.is_empty() {
        return Err(VidcallError::unauthorized(
            "Authorization header must use the Bearer scheme",
        ));
    }
    Ok(token)
}

/// Options for [`require_auth`].
struct AuthGuardOptions<'a> {
    /// Require the token's `role` to be `admin` (close/delete routes).
    admin: bool,
    /// Bind the token to one participant identity: participant tokens may
    /// only act as their own `participantId`; admin tokens are exempt.
    as_participant_id: Option<&'a str>,
}

/// Enforce room auth for one request. In open mode (no `state.auth`) this is
/// a no-op and returns `None`. Otherwise it validates the bearer token, its
/// room scope, and the requested role/identity.
fn require_auth(
    state: &AppState,
    headers: &HeaderMap,
    room_id: &str,
    opts: AuthGuardOptions,
) -> Result<Option<TokenClaims>> {
    let auth = match &state.auth {
        Some(auth) => auth,
        None => return Ok(None),
    };
    let claims = verify_token(&auth.secret, &bearer_token(headers)?)?;
    if claims.room_id != room_id {
        return Err(VidcallError::forbidden(format!(
            "Token is scoped to room {}, not {} (tokens are room-scoped)",
            claims.room_id, room_id
        )));
    }
    if opts.admin && claims.role != TokenRole::Admin {
        return Err(VidcallError::forbidden(
            "Admin role required for this operation",
        ));
    }
    if let Some(expected) = opts.as_participant_id {
        if claims.role != TokenRole::Admin && claims.participant_id != expected {
            return Err(VidcallError::forbidden(format!(
                "Token is bound to participant {}, not {}",
                claims.participant_id, expected
            )));
        }
    }
    Ok(Some(claims))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// JSON 404 for unknown paths and wrong methods (TS `dispatch` parity).
async fn not_found_handler() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": { "code": "not_found", "message": "No route for this path" }
        })),
    )
}

async fn auth_token_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>> {
    let auth = state
        .auth
        .as_ref()
        .ok_or_else(VidcallError::auth_not_configured)?;
    let body: AuthTokenBody = parse_body_as(&body)?;
    let room_id = body
        .room_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| VidcallError::invalid_request("Missing or invalid string field: roomId"))?;
    let participant_id = body
        .participant_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            VidcallError::invalid_request("Missing or invalid string field: participantId")
        })?;
    let role = match body.role.as_deref() {
        None | Some("participant") => TokenRole::Participant,
        Some("admin") => TokenRole::Admin,
        Some(other) => {
            return Err(VidcallError::invalid_request(format!(
                "role must be \"participant\" or \"admin\", got {other:?}"
            )))
        }
    };
    let admin_token = headers
        .get("adminToken")
        .or_else(|| headers.get("x-admin-token"))
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if role == TokenRole::Admin {
        if auth.admin_token.as_deref() != admin_token.as_deref() {
            return Err(VidcallError::forbidden(
                "Admin tokens require a valid adminToken header",
            ));
        }
    } else if auth.admin_token.is_some() && auth.admin_token.as_deref() != admin_token.as_deref() {
        return Err(VidcallError::unauthorized(
            "Missing or invalid adminToken header",
        ));
    }
    let now = now_ms();
    let ttl_sec = auth
        .default_token_ttl_ms
        .map(|ms| ms / 1000)
        .unwrap_or(DEFAULT_TOKEN_TTL_SECONDS);
    let token = issue_token(
        &auth.secret,
        crate::auth::IssueTokenOptions {
            room_id: room_id.clone(),
            participant_id: participant_id.clone(),
            role: Some(role),
            exp: Some(body.exp.unwrap_or(now / 1000 + ttl_sec)),
            now: Some(now),
        },
    )?;
    let claims = verify_token(&auth.secret, &token)?;
    Ok(Json(serde_json::json!({
        "token": token,
        "roomId": claims.room_id,
        "participantId": claims.participant_id,
        "role": claims.role,
        "exp": claims.exp,
        "iat": claims.iat,
    })))
}

async fn create_room_handler(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<axum::response::Response> {
    let body: CreateRoomBody = parse_body_as(&body)?;
    let room = create_room(
        &*state.store,
        CreateRoomOptions {
            room_id: body.room_id,
            max_participants: body.max_participants,
            metadata: body.metadata,
            now: None,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "room": room }))).into_response())
}

async fn join_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>> {
    let body: JoinBody = parse_body_as(&body)?;
    let nested = body.participant;
    let participant_id = nested
        .as_ref()
        .and_then(|p| p.participant_id.clone())
        .or(body.participant_id)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            VidcallError::invalid_request("Missing or invalid string field: participantId")
        })?;
    let session_id = nested
        .as_ref()
        .and_then(|p| p.session_id.clone())
        .or(body.session_id)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            VidcallError::invalid_request("Missing or invalid string field: sessionId")
        })?;
    let display_name = nested
        .as_ref()
        .and_then(|p| p.display_name.clone())
        .or(body.display_name);
    let metadata = nested
        .as_ref()
        .and_then(|p| p.metadata.clone())
        .or(body.metadata);

    // Token must be scoped to this room and bound to the joining participant.
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: Some(&participant_id),
        },
    )?;

    let input = ParticipantInput {
        participant_id,
        session_id,
        display_name,
        metadata,
    };
    let result =
        join_room(&*state.store, &room_id, input.clone(), JoinRoomOptions::default()).await?;
    // Broadcast the join so WS peers learn about the newcomer (delivered to
    // the post-join roster, mirroring the WS relay's fan-out).
    state.hub.broadcast(
        &room_id,
        &build_join_envelope(&room_id, &input),
        Some(&crate::ws::recipient_ids(&result.participants)),
    );
    Ok(Json(serde_json::json!({
        "room": result.room,
        "participant": result.participant,
        "participants": result.participants,
    })))
}

async fn leave_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>> {
    let body: LeaveBody = parse_body_as(&body)?;
    // Participants may only leave themselves; admins may remove anyone.
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: Some(&body.participant_id),
        },
    )?;
    let participant = state
        .store
        .get_participant(&room_id, &body.participant_id)
        .await?;
    let envelope = participant
        .as_ref()
        .map(|p| build_leave_envelope(&room_id, p, body.reason.as_deref()));
    let result = leave_room(
        &*state.store,
        &room_id,
        &body.participant_id,
        crate::core::LeaveRoomOptions {
            envelope,
            ..Default::default()
        },
    )
    .await?;
    if let Some(delivery) = &result.delivery {
        state.hub.broadcast(
            &room_id,
            &delivery.envelope,
            Some(&crate::ws::recipient_ids(&delivery.recipients)),
        );
    }
    Ok(Json(serde_json::json!({
        "room": result.room,
        "participants": result.participants,
    })))
}

async fn signal_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>> {
    let envelope = parse_body(&body)?;
    // Tokens are identity-bound: a participant may only signal as
    // themselves (mirror of the TS sibling's senderId check).
    let sender_id = envelope
        .get("senderId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: sender_id.as_deref(),
        },
    )?;
    let delivery = handle_signal(&*state.store, envelope).await?;
    if delivery.envelope.room_id == room_id {
        state.hub.broadcast(
            &room_id,
            &delivery.envelope,
            Some(&crate::ws::recipient_ids(&delivery.recipients)),
        );
    }
    Ok(Json(serde_json::json!({
        "seq": delivery.envelope.seq,
        "relayedTo": delivery.recipients.iter().map(|p| p.participant_id.clone()).collect::<Vec<_>>(),
    })))
}

async fn close_room_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: true,
            as_participant_id: None,
        },
    )?;
    let room = close_room(&*state.store, &room_id, Default::default()).await?;
    Ok(Json(serde_json::json!({ "room": room })))
}

async fn delete_room_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: true,
            as_participant_id: None,
        },
    )?;
    // The Store trait gives `delete_room` a no-op default (matching the TS
    // optional `deleteRoom?`), so unlike the TS sibling there is no
    // `not_implemented` path here.
    state.store.delete_room(&room_id).await?;
    Ok(Json(serde_json::json!({ "roomId": room_id, "deleted": true })))
}

async fn state_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RoomSnapshot>> {
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: None,
        },
    )?;
    let snapshot = get_room_state(&*state.store, &room_id).await?;
    Ok(Json(snapshot))
}

async fn recordings_handler(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    require_auth(
        &state,
        &headers,
        &room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: None,
        },
    )?;
    let recordings = get_recordings(&*state.store, &room_id).await?;
    Ok(Json(serde_json::json!({ "recordings": recordings })))
}

async fn chunks_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<axum::response::Response> {
    let storage = state.recording_storage.clone().ok_or_else(|| {
        VidcallError::recording_storage_error("No recording storage configured on this server")
    })?;
    let recording = state.store.get_recording(&session_id).await?;
    let Some(recording) = recording else {
        return Err(VidcallError::recording_not_found(&session_id));
    };
    // Recording routes are room-scoped: the token must cover the room.
    require_auth(
        &state,
        &headers,
        &recording.room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: None,
        },
    )?;
    if body.is_empty() {
        return Err(VidcallError::invalid_request(
            "Request body must be the raw chunk bytes",
        ));
    }
    // `?index=N` or `x-chunk-index: N` (TS sibling parity).
    let index_param = params
        .get("index")
        .map(String::as_str)
        .or_else(|| headers.get("x-chunk-index").and_then(|v| v.to_str().ok()));
    let index = match index_param {
        Some(raw) => raw.parse::<u64>().map_err(|_| {
            VidcallError::invalid_request("chunk index must be a non-negative integer")
        })?,
        None => 0,
    };
    storage.save_chunk(&session_id, &body, index).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({
        "sessionId": session_id,
        "index": index,
        "bytes": body.len(),
    })))
    .into_response())
}

async fn finalize_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let storage = state.recording_storage.clone().ok_or_else(|| {
        VidcallError::recording_storage_error("No recording storage configured on this server")
    })?;
    let recording = state.store.get_recording(&session_id).await?;
    let Some(recording) = recording else {
        return Err(VidcallError::recording_not_found(&session_id));
    };
    require_auth(
        &state,
        &headers,
        &recording.room_id,
        AuthGuardOptions {
            admin: false,
            as_participant_id: None,
        },
    )?;
    let storage_result = storage.finalize(&session_id).await?;
    let recording = stop_recording(&*state.store, &session_id, Default::default()).await?;
    Ok(Json(serde_json::json!({
        "recording": recording,
        "storage": storage_result,
    })))
}

// ---------------------------------------------------------------------------
// Error → HTTP response
// ---------------------------------------------------------------------------

impl axum::response::IntoResponse for VidcallError {
    fn into_response(self) -> axum::response::Response {
        let status = axum::http::StatusCode::from_u16(self.status)
            .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self.to_json())).into_response()
    }
}

/// Parse a request body as JSON. Empty bodies parse to `null` (the TS
/// sibling treats a missing body as `{}`); malformed JSON is a 400
/// `invalid_request` with the standard error envelope (the TS sibling parses
/// the body itself, so the envelope shape is identical).
fn parse_body(body: &Bytes) -> Result<serde_json::Value> {
    if body.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(body)
        .map_err(|e| VidcallError::invalid_request(format!("Malformed JSON body: {e}")))
}

/// Parse a request body into a typed shape; field-level errors are a 400
/// `invalid_request`.
fn parse_body_as<T: DeserializeOwned>(body: &Bytes) -> Result<T> {
    let value = parse_body(body)?;
    serde_json::from_value(value)
        .map_err(|e| VidcallError::invalid_request(format!("Invalid body: {e}")))
}

/// Convenience: build an [`AppState`] from parts (used by the binary).
pub fn make_state(
    store: Arc<dyn Store>,
    recording_storage: Option<Arc<dyn RecordingStorage>>,
) -> AppState {
    AppState {
        store,
        recording_storage,
        hub: Arc::new(RoomHub::new()),
        auth: None,
    }
}
