//! Wire protocol — mirror of `protocol/schema.json` and the TS mirror in
//! `protocol/types.ts`.
//!
//! One JSON envelope per message, carried over any backend pub/sub. The
//! schema's `additionalProperties` stay open, so additive extensions (e.g.
//! `targetSenderId`) survive a round-trip. Unknown fields are ignored;
//! unknown `type` values are ignored + logged by clients.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire protocol version (`schema.json` `properties.v.const`).
pub const PROTOCOL_VERSION: u8 = 1;

/// All envelope `type` values (`schema.json` `properties.type.enum`).
pub const MESSAGE_TYPES: &[&str] = &[
    "join",
    "leave",
    "offer",
    "answer",
    "ice",
    "presence",
    "reaction",
    "chat",
    "screen-share",
    "quality-warning",
    "sfu",
    "error",
    "ping",
    "pong",
];

/// One protocol envelope. `payload` is opaque JSON; the engine owns
/// ordering/idempotency/glare, backends stay dumb.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// Protocol version — must equal [`PROTOCOL_VERSION`].
    pub v: u8,
    /// Envelope type: one of [`MESSAGE_TYPES`].
    #[serde(rename = "type")]
    pub r#type: String,
    pub room_id: String,
    pub sender_id: String,
    /// Per-join id; guards against stale tabs/duplicates.
    pub session_id: String,
    /// Sender clock, epoch ms.
    pub ts: i64,
    /// Monotonic per sender; the engine dedupes/reorders.
    pub seq: i64,
    /// Additive extension: optional target for peer-addressed messages.
    /// Absent = room broadcast.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_sender_id: Option<String>,
    /// Schema payload for `type` (optional at the wire level).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

/// Validate an arbitrary JSON value as an envelope, mirroring the TS
/// `isEnvelope` in `protocol/types.ts`:
///  - `v` must equal 1,
///  - `type` must be one of [`MESSAGE_TYPES`],
///  - `roomId`/`senderId`/`sessionId` must be strings,
///  - `ts`/`seq` must be numbers.
pub fn is_envelope(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if obj.get("v").and_then(Value::as_i64) != Some(PROTOCOL_VERSION as i64) {
        return false;
    }
    let Some(r#type) = obj.get("type").and_then(Value::as_str) else {
        return false;
    };
    if !MESSAGE_TYPES.contains(&r#type) {
        return false;
    }
    for key in ["roomId", "senderId", "sessionId"] {
        if !obj.get(key).and_then(Value::as_str).is_some() {
            return false;
        }
    }
    for key in ["ts", "seq"] {
        if !obj.get(key).is_some_and(Value::is_number) {
            return false;
        }
    }
    true
}

/// Convert a validated JSON value into an [`Envelope`].
///
/// `ts`/`seq` accept any JSON number (JS clients send doubles; integers in
/// practice) and are coerced to `i64`, matching the TS `typeof number` check.
pub fn envelope_from_value(value: Value) -> Option<Envelope> {
    if !is_envelope(&value) {
        return None;
    }
    let obj = value.as_object()?;
    let ts = obj.get("ts")?.as_f64()? as i64;
    let seq = obj.get("seq")?.as_f64()? as i64;
    Some(Envelope {
        v: PROTOCOL_VERSION,
        r#type: obj.get("type")?.as_str()?.to_string(),
        room_id: obj.get("roomId")?.as_str()?.to_string(),
        sender_id: obj.get("senderId")?.as_str()?.to_string(),
        session_id: obj.get("sessionId")?.as_str()?.to_string(),
        ts,
        seq,
        target_sender_id: obj
            .get("targetSenderId")
            .and_then(Value::as_str)
            .map(str::to_string),
        payload: obj.get("payload").cloned(),
    })
}

/// Build a valid envelope with defaults for `ts`/`seq` (caller may override).
pub fn create_envelope(
    r#type: &str,
    room_id: &str,
    sender_id: &str,
    session_id: &str,
    payload: Option<Value>,
) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        r#type: r#type.to_string(),
        room_id: room_id.to_string(),
        sender_id: sender_id.to_string(),
        session_id: session_id.to_string(),
        ts: now_ms(),
        seq: 0,
        target_sender_id: None,
        payload,
    }
}

/// Epoch milliseconds (monotonic-ish clock for ids; wall clock for ts).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
