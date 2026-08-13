//! Typed error model, mirroring `packages/server/src/errors.ts`.
//!
//! Every failure surfaced by the core functions and the HTTP/WS layer is a
//! [`VidcallError`] with a stable machine-readable `code`, a human message and
//! an HTTP status for the REST layer. Framework adapters map these to their
//! native error responses; reverse proxies pass the status + JSON body through
//! verbatim.

use serde::Serialize;

/// Stable machine-readable error codes (same strings as the TS sibling).
pub const ERROR_CODES: &[&str] = &[
    "room_not_found",
    "room_already_exists",
    "room_closed",
    "room_full",
    "participant_not_found",
    "participant_already_joined",
    "recording_not_found",
    "invalid_envelope",
    "invalid_request",
    "recording_storage_error",
    "internal_error",
    // auth (HTTP/WS guard layer, see auth.rs)
    "unauthorized",
    "token_expired",
    "forbidden",
    "auth_not_configured",
    // optional Store capabilities
    "not_implemented",
];

/// Wire shape: `{ "error": { "code", "message", "details?" } }`.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// The one error type the whole crate throws.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct VidcallError {
    /// Stable machine-readable code (see [`ERROR_CODES`]).
    pub code: &'static str,
    /// Human-readable message.
    pub message: String,
    /// HTTP status for the REST layer.
    pub status: u16,
    /// Optional structured details.
    pub details: Option<serde_json::Value>,
}

impl VidcallError {
    /// Build an error with an explicit code/message/status.
    pub fn new(code: &'static str, message: impl Into<String>, status: u16) -> Self {
        Self {
            code,
            message: message.into(),
            status,
            details: None,
        }
    }

    /// Attach structured details.
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Serialize to the wire shape `{ "error": { code, message, details? } }`.
    pub fn to_json(&self) -> ErrorBody {
        ErrorBody {
            error: ErrorDetail {
                code: self.code.to_string(),
                message: self.message.clone(),
                details: self.details.clone(),
            },
        }
    }

    // ---- factories (one per code, so call sites stay terse) --------------

    pub fn room_not_found(room_id: &str) -> Self {
        Self::new("room_not_found", format!("Room not found: {room_id}"), 404)
    }
    pub fn room_already_exists(room_id: &str) -> Self {
        Self::new(
            "room_already_exists",
            format!("Room already exists: {room_id}"),
            409,
        )
    }
    pub fn room_closed(room_id: &str) -> Self {
        Self::new("room_closed", format!("Room is closed: {room_id}"), 409)
    }
    pub fn room_full(room_id: &str) -> Self {
        Self::new("room_full", format!("Room is full: {room_id}"), 409)
    }
    pub fn participant_not_found(room_id: &str, participant_id: &str) -> Self {
        Self::new(
            "participant_not_found",
            format!("Participant not in room {room_id}: {participant_id}"),
            404,
        )
    }
    pub fn participant_already_joined(room_id: &str, participant_id: &str) -> Self {
        Self::new(
            "participant_already_joined",
            format!("Participant already joined room {room_id}: {participant_id}"),
            409,
        )
    }
    pub fn recording_not_found(session_id: &str) -> Self {
        Self::new(
            "recording_not_found",
            format!("Recording session not found: {session_id}"),
            404,
        )
    }
    pub fn invalid_envelope(message: impl Into<String>) -> Self {
        Self::new("invalid_envelope", message, 400)
    }
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message, 400)
    }
    pub fn recording_storage_error(message: impl Into<String>) -> Self {
        Self::new("recording_storage_error", message, 500)
    }
    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new("internal_error", message, 500)
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new("unauthorized", message, 401)
    }
    pub fn token_expired(message: impl Into<String>) -> Self {
        Self::new("token_expired", message, 401)
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new("forbidden", message, 403)
    }
    pub fn auth_not_configured() -> Self {
        Self::new(
            "auth_not_configured",
            "Auth is not configured on this server (set --auth-secret or VIDCALL_AUTH_SECRET)",
            501,
        )
    }
    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self::new("not_implemented", message, 501)
    }
}

/// Shorthand used across handlers.
pub type Result<T, E = VidcallError> = std::result::Result<T, E>;
