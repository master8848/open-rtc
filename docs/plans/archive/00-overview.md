# 00 — Overview: Mesh → Ultimate Calling Lib

> Executive summary for expanding vidcall from mesh-only to the default JS/TS calling library: 1:1, mesh 2-4, SFU 5-500, hybrid auto, flexible transport/media, horizontal scale, plug-and-play bundles.

## Executive summary

vidcall 0.1.0 is a mesh-only calling engine (`Room` + `PeerConnectionManager` perfect negotiation + trickle ICE) with pluggable signaling backends (Supabase/Convex/Firebase/Appwrite/Postgres/SQLite) and an adaptive quality ladder. It is correct for the "simple Zoom clone" tier but caps at ~4 participants O(N²). `packages/sfu-gateway/src/sfu-gateway.ts:15` scaffolds `SfuGateway`/`SfuRouter`/`MediasoupAdapter` against the versioned protocol `sfu` envelope — compiled and unit-tested but **not wired into `Room`** (`docs/architecture.md:32`). `packages/server/src/ws.ts:58` `RoomHub Map<room,Set<Socket>>` and `packages/server/src/stores/InMemoryStore.ts:14` are in-process only — no Redis/NATS pub/sub. `packages/transport/src/internal/chunker.ts:53` works around Postgres `NOTIFY` 7 KB cap, but Supabase-per-publisher broadcast rate limits still kill ICE bursts without the dedicated WS coalescing + `IceCoalescer` path (`packages/server/src/ws.ts:119`). `README.md:107` notes pre-1.0, not on npm, breaking changes expected. `RoomConfig.transport: SignalingTransport` is a single path — no composite primary/fallback, no WebTransport, no media-transport seam.

This plan takes vidcall to **ultimate calling lib** in 5 additive phases: API design → transport/media flexibility → SFU wiring (+ cascading) → horizontal scale → bundle splits. Each phase is independently shippable; together they unlock 1:1/mesh/SFU/hybrid, flexible media + transport, and horizontally scaled relay with pay-for-what-you-use installs.

## Goals

1. **Topologies:** 1:1 p2p • mesh 2–4 (zero infra) • SFU 5–500 (auto-switch, cascading multi-router) • WHIP ingest / WHEP egress; `topology: 'auto'` default.
2. **Media types:** audio / video / screenshare / data-channel today; extensible to HLS/RTMP live-stream, SIP/PSTN, WHIP/WHEP, recording/transcription, custom media-processor chain (denoise, virtual-bg).
3. **Transports:** signaling pluggable per-kind (primary + reconnect + fallback composite), reconnect-resilient, horizontally fan-out; media behind a `MediaTransport` seam so `Room` never constructs `RTCPeerConnection` directly (test seam + SFU/WHIP swap).
4. **Secure + non-secure:** open mode stays zero-config; secure mode is token-scoped `room+identity` (existing `packages/server/src/auth.ts:107` HS256) + optional E2EE/SFrame with key rotation + TURN + recording ACL — same API, flag-driven.
5. **Recording as product feature:** client composite (`MediaRecorder`) + server selective (SFU consumer→file) + mixed/composited egress behind one `room.recording` surface (`RecordingStorage` `Disk`/`S3` via SigV4 already in place).
6. **Plug-and-play installs:** `bun add @mbsks/openrtc-core` is <15 kB gz zero-dep; adding a backend or SFU is one extra `add`. Heavy peers (`pg`, `mediasoup`, `firebase`) are optional + lazy-imported, tree-shakable via `sideEffects:false` and `exports` subpaths.
7. **DX at TanStack level:** `roomOptions` factories, `select` for derived slices, `useSuspenseRoomState`, mutations with optimistic local echo, `VidcallClient` deduping `Room` by `[roomId,selfId]`, devtools envelope ring buffer. Snapshot stays `useSyncExternalStore`-compatible.

## Non-goals / constraints

- **Monorepo rules (must not break):** `bun` workspaces `packages/*` + `protocol` (`package.json:9`), `tsc -b` project refs (`tsconfig.json:3`, `tsconfig.base.json:5` `module:NodeNext`, `composite:true`), `type:module` everywhere, `sideEffects:false` (audited), **no bundler/minifier in core publish** — keep `tsc` output.
- **Bundling perspectives:** `bun` for install/orchestration, `tsc -b` for typecheck ordering, optional `rslib` (rspack) for publish artifacts (ESM+CJS+dts-bundled) — libraries must not code-split, consumers do. `Rsbuild`/`Bun.build` for apps/server binary only.
- **Rust perspective:** no Rust for 0.1–1.0 client. `mediasoup` C++ worker is already the fast path; `str0m`/`webrtc.rs` are DIY SFUs with high cost. Only justified Rust is an optional signaling relay sidecar (axum+tokio) *after* JS relay is proven bottleneck at >10k rooms/WS. Until then, Node `ws` + Redis pub/sub.
- **Pre-1.0 contract:** breaking changes allowed until 1.0; ship additive migrations with deprecation shims where feasible (see `01-api-design.md`).

## Current limits (with file anchors)

| Area | File | Limit |
|------|------|-------|
| Topology | `packages/sfu-gateway/src/sfu-gateway.ts:15`, `docs/architecture.md:32` | Scaffold vs wiring TODO; mesh only O(N²) |
| Relay | `packages/server/src/ws.ts:58`, `packages/server/src/stores/InMemoryStore.ts:14` | `RoomHub` Map in-process, `InMemoryStore` per-process |
| NOTIFY | `packages/transport/src/internal/chunker.ts:53` | 7 KB `NOTIFY` chunker; `LISTEN` needs dedicated `pg` client |
| Rate limits | `packages/server/src/ws.ts:119` coalescing | Without WS relay, Supabase broadcast throttles ICE bursts |
| Publish | `README.md:107`, `package.json:2` | `private:true`, `0.1.0`, not on npm |
| Config | `packages/core/src/room.ts:191` `RoomConfig.transport` | Single `SignalingTransport` path; no composite/media seam |
| Needed flexibility | — | Audio/video/screenshare/data-channel/HLS/WHIP/WHEP/recording/transcription share one path |

## Target architecture (end state)

```
App ── @mbsks/openrtc-react (useRoomState/select/suspense, VidcallClient)
        │
       @mbsks/openrtc-core  Room ─┬─ SignalingTransport (composite: primary+fallback+reconnect, per-kind)
                            │   ├─ composite over backends: supabase|convex|firebase|postgres|...
                            │   └─ WS relay coalesces ICE, Redis pub/sub fans out
                            ├─ MediaTransport seam (mesh vs SFU vs WHIP/WHEP) — Room never new RTCPeerConnection
                            │   ├─ MeshTransport (PeerConnectionManager per peer)
                            │   ├─ SfuTransport (SfuGateway/SfuRouter/MediasoupAdapter, cascading)
                            │   └─ WhipTransport / HlsEgress
                            ├─ ProcessorChain (per-track: denoise/bg/SFrame E2EE, simulcast/SVC)
                            └─ RecordingFacade (client composite + SFU egress)
        │
       @mbsks/openrtc-server  WS relay + Store (Redis pub/sub RoomHub, Postgres/SQLite/MySQL stores)
       @mbsks/openrtc-sfu-gateway  SfuGateway adapter surface (mediasoup ref, lazy peer dep)
       @mbsks/openrtc-transport  chunker/reorder/heartbeat/IceCoalescer/shared-tests
```

## Phases (dependency order)

| # | File | Focus | Depends |
|---|------|-------|---------|
| 0 | `00-overview.md` (this file) | Scope, constraints, metrics | — |
| 1 | `01-api-design.md` | TanStack-inspired API, `exports` map, backwards compat | 00 |
| 2 | `02-transport-media-flexibility.md` | `Transport`/`Media` abstraction, per-kind media, E2EE/SFrame, simulcast/SVC | 01 |
| 3 | `03-sfu-wiring.md` | `SfuGateway`/`SfuRouter`/`MediasoupAdapter` → `Room`, topology selector, cascading | 02 |
| 4 | `04-horizontal-scale.md` | Redis pub/sub `RoomHub`, horizontal WS relay, presence, LB test | 03 |
| 5 | `05-bundle-splitting.md` | `exports` subpaths, `sideEffects:false`, ESM+CJS, rslib/Rsbuild chunking, dts, tree-shaking | 01–04 |

Phases 1 and 5 can start in parallel with 2; 3 needs 2; 4 is independent of 3 but benefits from 2's transport seam.

## Success metrics (acceptance gates)

- **Topologies:** 1:1 and mesh-4 p2p work with zero infra; SFU 30-participant fan-out <150 ms p95 `publish→subscribe`; `auto` switches mesh→SFU at configurable N (default 4→5) without media loss; cascading: 2 SFU routers share roster/signals.
- **Transport/media:** composite fallback delivers when primary backend throttles (inject 20 ICE/s, zero drops); `MediaTransport` seam lets tests inject fake without touching `Room`; E2EE/SFrame round-trips; simulcast/SVC layer switch via `setPreferredLayers`.
- **Scale:** 2 server instances behind LB share signals+presence via Redis pub/sub; InMemoryStore replaced by pluggable `Store` with `ioredis`/`redis` peer dep; WS relay coalesces ICE; Postgres `LISTEN` on dedicated client, no 7 KB loss.
- **Bundle:** `bun add @mbsks/openrtc-core` <15 kB gz zero-dep; backend/SFU/server are optional imports (optional peers, `await import()`); `publint` + `attw --pack` + `size-limit` green; dual ESM+CJS where needed without breaking `type:module`.
- **DX:** `useRoomState(room, select)` has referential stability (`roomSnapshotsEqual`); `useSuspenseRoomState` suspends while `status==='joining'`; `VidcallClient` dedupes `Room` by `[roomId,selfId]` (StrictMode-safe via `JoinOptions.signal`); devtools ring buffer replaces single `debug` fn.
- **Quality gates:** `bun run build` (`tsc -b`), `bun run test` + transport `vitest`, SFU `VIDCALL_MEDIASOUP_INTEGRATION=1` real-worker pass, `oxlint`/`oxfmt`, `publint`/`attw`, changesets.

## Risks & mitigations

- **Backend rate limits kill signaling** — chunker + coalesce ICE; `CompositeTransport` with WS relay fallback; document per-backend limits.
- **TURN cost/complexity** — mesh default; document coTURN; SFU path for scale; TURN credentials behind token scope.
- **Supply-chain** — 14-day age gate re-run at publish; committed lockfiles; optional peers keep heavy SDKs out of core.
- **Native binding drift** — L0 `protocol/` JSON Schema + fixtures as merge gate; codegen stays single source.
- **Rust temptation** — defer until JS relay proven bottleneck (>10k rooms/WS); then optional Rust relay sidecar (axum+tokio), not client.

## How to use this plan

Review files in order. Each file has: objective, current state, desired state, API snippets, package/file changes, tasks checklist, risks, verification. Cross-links note dependencies. The `plans/01-security.md`…`07-roadmap.md` series remains for security/recording/roadmap depth — this `00–05` series is the mesh→SFU expansion spine.
