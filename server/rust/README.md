# vidcall-server (Rust sidecar)

The vidcall backend as a small, language-agnostic Rust component: rooms,
participant rosters, the per-room signal log, envelope relay over HTTP +
WebSocket, and recording storage. Any app backend (Django / Laravel /
Express / Fastify / Rails) attaches to it via a reverse proxy — see the
route table below.

It mirrors the TypeScript sibling (`packages/server`): same JSON envelopes,
same status codes, same error shapes, same auth contract (HMAC room tokens).
The core relay logic (`crates/vidcall-server/src/core.rs`) is framework-free
and store-agnostic; it runs identically on InMemory, SQLite, Postgres,
Convex, Supabase, or any REST backend.

## Build

```sh
cargo build --release
```

The release binary is stripped and small — measured **5.8 MiB** on arm64
(macOS), comfortably under the 10 MiB budget (`strip = true`, `lto = "thin"`,
`panic = "abort"` in `[profile.release]`). Verify with:

```sh
file target/release/vidcall-server   # Mach-O/ELF, stripped
ls -lh target/release/vidcall-server
```

## Run

```sh
vidcall-server --addr 127.0.0.1:8787                          # in-memory, /v1/*
vidcall-server --store sqlite --sqlite-path ./vidcall.db      # SQLite
vidcall-server --store postgres --database-url "postgres://u:p@localhost/vidcall"
vidcall-server --store convex --convex-url "https://<deployment>.convex.cloud"
vidcall-server --recordings-dir ./recordings                  # disk recording storage
vidcall-server --auth-secret "$SECRET"                        # HMAC token auth mode
```

Configuration is also read from `VIDCALL_*` environment variables
(`VIDCALL_STORE`, `VIDCALL_DATABASE_URL`, `VIDCALL_CONVEX_URL`,
`VIDCALL_SUPABASE_URL`, `VIDCALL_SUPABASE_KEY`, `VIDCALL_HTTP_JSON_URL`,
`VIDCALL_RECORDINGS_DIR`, `VIDCALL_ADDR`, `VIDCALL_ROUTE_PREFIX`,
`VIDCALL_AUTH_SECRET`, `VIDCALL_AUTH_ADMIN_TOKEN`).

## Routes (prefix defaults to `/v1`)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/token` | issue a room-scoped HMAC token (auth mode) |
| `POST` | `/v1/rooms` | create a room |
| `POST` | `/v1/rooms/:id/join` | join a room (adds participant) |
| `POST` | `/v1/rooms/:id/leave` | leave a room |
| `POST` | `/v1/rooms/:id/signal` | relay one protocol envelope |
| `POST` | `/v1/rooms/:id/close` | close a room (admin only) |
| `DELETE` | `/v1/rooms/:id` | delete a room (admin only) |
| `GET` | `/v1/rooms/:id/state` | room + participant roster |
| `GET` | `/v1/rooms/:id/recordings` | recording sessions |
| `POST` | `/v1/recordings/:sessionId/chunks` | upload one media chunk (raw body) |
| `POST` | `/v1/recordings/:sessionId/finalize` | seal a recording session |
| `WS` | `/v1/ws?roomId=&token=` | live envelope relay |

Auth mode (`--auth-secret`): room routes require `Authorization: Bearer
<token>`; WS joins require `?token=<token>` in the upgrade URL; tokens are
HMAC-SHA256 (HS256) JWT-style, room-scoped and identity-bound. With
`--auth-admin-token` set, `POST /auth/token` requires an `adminToken` (or
`x-admin-token`) header, and `role: "admin"` always does.

## Verify

```sh
cargo test          # unit + integration + doctests (REST, WS, stores, recordings)
cargo clippy --all-targets   # zero warnings
cargo fmt --check   # rustfmt clean
./scripts/check-supply-chain.sh   # every Cargo.lock crate >= 14 days old on crates.io
```

The integration suites (`crates/vidcall-server/tests/`) prove the wire
contract against a real listener: REST envelopes, WS join/ack/fan-out with
no sender echo, peer-addressed envelopes, presence/leave/disconnect
broadcasts, REST mutations fanning out to WS sockets, guarded-mode auth
(Bearer + `?token=` + 4401 close), and recording chunk/finalize flows.

## Layout

```
src/core.rs          framework-free room/roster/signal/recording logic
src/http.rs          REST handlers + axum router (one router for every host)
src/ws.rs            WS relay + in-process RoomHub (REST mutations fan out)
src/auth.rs          HMAC room tokens (port of packages/server/src/auth.ts)
src/recording.rs     recording byte storage (disk, S3-compatible + SigV4)
src/store.rs         Store trait (change feed included)
src/stores/          InMemory, SQLite, Postgres, Convex, Supabase, generic REST
tests/               integration suites (http, ws, recording, store suites)
scripts/             check-supply-chain.sh
```
