# Changelog

Notable changes to vidcall. Package-level release notes are maintained by
[changesets](https://github.com/changesets/changesets) in each package's own
`CHANGELOG.md`; this file is the repo-wide summary. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

The feature wave of 2026-08-25, pending its first versioned release.

### Added

- **core: observable snapshot layer.** `room.subscribe(listener)` and
  `room.getSnapshot()` expose an immutable room snapshot for
  `useSyncExternalStore`-style consumers; `join()` is now abortable and
  serialized so concurrent joins can't interleave negotiation steps.
- **@vidcall/react (new package).** `useRoomState`, `useParticipants`,
  `useParticipant`, and `useJoin` hooks over the core snapshot store,
  StrictMode-safe.
- **server: zero-driver default install.** SQL stores and framework adapters
  moved behind subpath exports; database drivers became optional peer
  dependencies with actionable install errors and packaging guards.
- **protocol: full TypeScript L0 conformance parity.** The TS suite now runs
  the same canonical fixture set as the Kotlin/Dart bindings (50 tests:
  round-trip, payloads, targeted/broadcast routing, unknown-envelope
  tolerance, schema coverage).

### Fixed

- server: REST `join`/`leave`/signal fan-out reached only sockets connected
  before the first request — `RoomHub` was documented as `services.relay` but
  never assigned.
- server: the standalone node server crashed on oversized bodies via an
  unhandled rejection; it now answers 413.
- server: default SigV4 `x-amz-date` was malformed (fractional seconds kept,
  trailing `Z` dropped); it is now compact `YYYYMMDDTHHMMSSZ`, with a
  regression test.
- transport: reorder-buffer test envelopes carried payloads that no protocol
  type defines.
- examples/react: stable `selfId` fixes a StrictMode ghost roster entry; the
  example now consumes the `@vidcall/react` hooks.

## History

Condensed from the commit log (2026-08-11 → 2026-08-25), grouped by area.
There are no tagged releases yet; everything below predates the unreleased
wave above.

### Core engine & adaptive quality

- Mesh WebRTC engine: `Room`, `PeerConnectionManager` (perfect negotiation,
  trickle ICE, renegotiation, ICE restart), `SignalingTransport` interface,
  `DataChannelBus`; quality policy engine over stats snapshots; fake RTC
  test-utils — 84 tests green at inception.
- Controls manager (mute, camera, screen share, reactions, device selection),
  device management (`listDevices`/`switchCamera`/`restartTrack`/
  `setFacingMode`) with an injectable `MediaDevicesLike` seam, and the
  `room.devices` facade with change events.
- Recording hooks (MediaRecorder + composite local/remote tracks) with server
  upload and a room facade.

### Protocol

- Wire schema (`schema.json`) as single source of truth, then canonical L0
  fixtures consumed by every language binding's conformance suite.
- Targeted delivery: `targetSenderId` envelope field across schema + all
  bindings (sender-excluded relay; receivers filter).
- Glare polarity rule unified on `polite = selfId < remoteId` across Kotlin,
  Swift, Dart, and TS.

### Client transports & signaling backends

- `@vidcall/transport`: transport twin + helpers (chunker, reorder buffer,
  heartbeat, ICE coalescer), `InMemoryBackend`, and the shared adapter test
  suite all client backends run against.
- Six backend adapters, each green on the shared suite: Supabase Realtime,
  Convex mutations/subscriptions, Postgres LISTEN/NOTIFY (7 KB chunker,
  heartbeat + table presence), SQLite via `@libsql/client`
  (BroadcastChannel), Firebase RTDB (native `onDisconnect` presence), and
  Appwrite.

### Server & SFU

- Reference TS signaling server: room/session/recording logic, `Store`
  contract, InMemory/SQLite/Postgres/MySQL stores, REST+WS relay, Express and
  Fastify adapters, disk/S3 recording storage (SigV4 over fetch, no AWS SDK).
- HMAC room tokens + guarded HTTP/WS routes; admin token issuance requires a
  configured `adminToken`.
- Optional mediasoup-based SFU gateway scaffolded on mediasoup 3.23 APIs.
- Rust sidecar relay under `server/rust` with a supply-chain check script.

### Native bindings

- Swift: protocol models (Codable) + `VidcallClient`, optional WebRTC layer
  behind an injectable session seam, serialized signaling ops, offline-WebRTC
  default build; L0 conformance suite.
- Dart: protocol models mirroring `schema.json`, `VidcallClient` over
  `dart:io` WebSocket, flutter_webrtc mesh session (`RtcMeshSession`,
  one socket / N−1 uplinks), glare-hardening tests reading canonical fixtures.
- Kotlin: protocol module (kotlinx.serialization) + Android WebRTC peer
  manager, tolerant unknown-type decode, L0 conformance suite.

### Docs, examples & tooling

- Root README rewrite; package READMEs for core/quality/server/backends/
  bindings/sfu-gateway; architecture, features, testing-matrix, and
  integration guides; competitive research and internal review docs.
- Examples: vanilla two-tab BroadcastChannel call, React + Supabase room,
  Express + `@vidcall/server` host.
- Repo scaffolding, MIT license, GitHub Actions matrix (node 20/22, Swift,
  Dart, Kotlin), CONTRIBUTING.md codifying dependency-age/exact-pin/adapter
  policies, and workspace wiring for each new package.
