//! vidcall-server — the vidcall backend as a lightweight Rust sidecar.
//!
//! One small Rust component that any app can attach: rooms, participant
//! rosters, the per-room signal log, envelope relay and recording storage
//! over HTTP + WebSocket, with pluggable [`Store`](store::Store) backends
//! (InMemory, SQLite, Postgres, Convex, Supabase, any REST BaaS) and
//! [`RecordingStorage`](recording::RecordingStorage) (disk, S3-compatible).
//!
//! Language-agnostic over HTTP/WS — Django/Laravel/Express/Fastify/Rails
//! apps attach via a reverse proxy (see `integrations/ATTACH.md`).
//!
//! ```
//! use vidcall_server::{router, stores::InMemoryStore};
//! # async fn example() {
//! let app = router(InMemoryStore::new()); // axum Router, ready to merge
//! # let _ = app;
//! # }
//! ```

pub mod auth;
pub mod aws_sigv4;
pub mod core;
pub mod error;
pub mod http;
pub mod protocol;
pub mod recording;
pub mod shared_tests;
pub mod store;
pub mod stores;
pub mod types;
pub mod ws;

pub use error::{Result, VidcallError};
pub use http::{router, router_with_state};
pub use store::{SignalInput, Store};
pub use types::{Participant, RecordingSession, Room, StoredSignal};
