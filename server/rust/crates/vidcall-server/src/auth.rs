//! HMAC-signed room tokens — port of `packages/server/src/auth.ts`.
//!
//! Zero-dependency auth (no JWT crate): compact JWT-style tokens
//! (`header.payload.signature`, base64url, HS256) that bind a caller to one
//! room and one participant identity:
//!
//!  - [`issue_token`] mints a token for your host app / the `POST /auth/token`
//!    endpoint.
//!  - [`verify_token`] validates signature + expiry and returns the claims,
//!    or a `VidcallError` (`unauthorized`/`token_expired` → 401,
//!    `forbidden` → 403) that the HTTP/WS guard layers map to the standard
//!    `{ "error": { code, message } }` envelope.
//!
//! Room-scoped: a token minted for room X cannot join, signal in, or read
//! room Y (the guard layers in `http.rs` / `ws.rs` enforce the match).
//! Roles: `participant` (join/signal/state/recordings for their room) and
//! `admin` (additionally close/delete rooms and read any room state).
//!
//! Timestamps follow the JWT convention: **epoch seconds**.
//!
//! The signing input is serialized with the exact key order of the TS
//! sibling (`JSON.stringify` insertion order), so tokens minted by either
//! implementation verify on the other when they share a secret.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::{Result, VidcallError};

/// Who the token holder is allowed to act as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenRole {
    Participant,
    Admin,
}

/// Verified token claims (epoch seconds for `iat`/`exp`, JWT convention).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenClaims {
    /// The only room this token grants access to.
    pub room_id: String,
    /// The participant identity the token is bound to (enforced by guards).
    pub participant_id: String,
    pub role: TokenRole,
    /// Expiry, epoch seconds.
    pub exp: i64,
    /// Issued-at, epoch seconds.
    pub iat: i64,
}

/// Options for [`issue_token`].
#[derive(Debug, Clone, Default)]
pub struct IssueTokenOptions {
    pub room_id: String,
    pub participant_id: String,
    /// Default `TokenRole::Participant`.
    pub role: Option<TokenRole>,
    /// Expiry, epoch seconds. Defaults to `now + DEFAULT_TOKEN_TTL_SECONDS`.
    pub exp: Option<i64>,
    /// Clock override (tests); epoch ms.
    pub now: Option<i64>,
}

/// Default token lifetime when `exp` is omitted (1 hour).
pub const DEFAULT_TOKEN_TTL_SECONDS: i64 = 60 * 60;

fn b64url_encode(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(input)
}

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(input).ok()
}

fn hmac_sha256(data: &[u8], secret: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret)
        .expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Constant-time string comparison (length leak is acceptable: hashes).
fn safe_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn require_nonempty(value: &str, name: &str) -> Result<()> {
    if value.is_empty() {
        return Err(VidcallError::invalid_request(format!(
            "{name} must be a non-empty string"
        )));
    }
    Ok(())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

/// Mint a compact JWT-style token: `base64url(header).base64url(payload)`
/// signed with HMAC-SHA256 (HS256). The token is room- AND identity-scoped:
/// guards reject it for any other `roomId` or `participantId`.
pub fn issue_token(secret: &str, opts: IssueTokenOptions) -> Result<String> {
    require_nonempty(secret, "secret")?;
    require_nonempty(&opts.room_id, "roomId")?;
    require_nonempty(&opts.participant_id, "participantId")?;
    let role = opts.role.unwrap_or(TokenRole::Participant);
    let now_sec = opts
        .now
        .unwrap_or_else(crate::protocol::now_ms)
        / 1000;
    let exp = opts.exp.unwrap_or(now_sec + DEFAULT_TOKEN_TTL_SECONDS);

    // TS sibling serializes with JSON.stringify insertion order — keep the
    // exact field order so tokens are interchangeable between the two.
    let header = r#"{"alg":"HS256","typ":"JWT"}"#;
    let role_str = match role {
        TokenRole::Participant => "participant",
        TokenRole::Admin => "admin",
    };
    let payload = format!(
        "{{\"roomId\":{},\"participantId\":{},\"role\":{},\"exp\":{},\"iat\":{}}}",
        json_string(&opts.room_id),
        json_string(&opts.participant_id),
        json_string(role_str),
        exp,
        now_sec
    );
    let signing_input = format!(
        "{}.{}",
        b64url_encode(header.as_bytes()),
        b64url_encode(payload.as_bytes())
    );
    let signature = hmac_sha256(signing_input.as_bytes(), secret.as_bytes());
    Ok(format!("{signing_input}.{}", b64url_encode(&signature)))
}

/// Validate a token: format, algorithm, HMAC signature (constant-time), and
/// expiry. Returns the claims on success.
///
/// Errors: `unauthorized` (malformed/tampered/unsupported), `token_expired`
/// (`exp <= now`).
pub fn verify_token(secret: &str, token: &str) -> Result<TokenClaims> {
    require_nonempty(secret, "secret")?;
    if token.is_empty() {
        return Err(VidcallError::unauthorized("Missing or empty token"));
    }
    let mut parts = token.split('.');
    let h = parts.next().unwrap_or("");
    let p = parts.next().unwrap_or("");
    let sig = parts.next().unwrap_or("");
    if parts.next().is_some() || h.is_empty() || p.is_empty() || sig.is_empty() {
        return Err(VidcallError::unauthorized(
            "Malformed token: expected header.payload.signature",
        ));
    }

    let header: serde_json::Value = serde_json::from_slice(
        &b64url_decode(h).ok_or_else(|| {
            VidcallError::unauthorized("Malformed token: invalid base64url or JSON")
        })?,
    )
    .map_err(|_| VidcallError::unauthorized("Malformed token: invalid base64url or JSON"))?;
    let payload: serde_json::Value = serde_json::from_slice(
        &b64url_decode(p).ok_or_else(|| {
            VidcallError::unauthorized("Malformed token: invalid base64url or JSON")
        })?,
    )
    .map_err(|_| VidcallError::unauthorized("Malformed token: invalid base64url or JSON"))?;

    if header.get("alg").and_then(serde_json::Value::as_str) != Some("HS256") {
        return Err(VidcallError::unauthorized(format!(
            "Unsupported token algorithm: {}",
            header
                .get("alg")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )));
    }
    let expected_sig = hmac_sha256(format!("{h}.{p}").as_bytes(), secret.as_bytes());
    let expected_sig = b64url_encode(&expected_sig);
    if !safe_equal(&expected_sig, sig) {
        return Err(VidcallError::unauthorized(
            "Token signature verification failed (tampered token?)",
        ));
    }

    let room_id = payload
        .get("roomId")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| VidcallError::unauthorized("Malformed token: missing roomId"))?
        .to_string();
    let participant_id = payload
        .get("participantId")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| VidcallError::unauthorized("Malformed token: missing participantId"))?
        .to_string();
    let role = match payload.get("role").and_then(serde_json::Value::as_str) {
        Some("participant") => TokenRole::Participant,
        Some("admin") => TokenRole::Admin,
        _ => return Err(VidcallError::unauthorized("Malformed token: role must be \"participant\" or \"admin\"")),
    };
    let exp = payload
        .get("exp")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| VidcallError::unauthorized("Malformed token: invalid exp"))?;

    let now_sec = crate::protocol::now_ms() / 1000;
    if exp <= now_sec {
        return Err(VidcallError::token_expired(format!(
            "Token expired at {}",
            chrono_like(exp)
        )));
    }

    Ok(TokenClaims {
        room_id,
        participant_id,
        role,
        exp,
        iat: payload
            .get("iat")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(now_sec),
    })
}

/// Human-readable RFC 3339-ish timestamp for expiry messages (no chrono dep).
fn chrono_like(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86400);
    let rem = epoch_secs.rem_euclid(86400);
    let (y, m, d) = crate::aws_sigv4::civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
