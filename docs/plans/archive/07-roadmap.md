# 07 — Roadmap: Phased Execution to 1.0

> All phases are additive. Each milestone ships independently behind flags; 1.0 is the integration point where breaking changes stop.

## Sequencing

```
M0  Foundations  (2-3 weeks)  04-scale P0 + 05-packaging P0 + 01-security P0
  └─ unblocks horizontal rooms, publish shape, token flow
M1  SFU Core     (3-4 weeks)  03-media-topology P0 (MediaTransport + Sfu wiring)
  └─ unblocks 02-recording SFU modes
M2  Secure-by-default + Recording product (2-3 weeks)  01 E2EE/TURN + 02 SFU recording
M3  Resilience   (2 weeks)    04 Composite/Reconnect/WebTransport + limits doc
M4  DX & Scale polish (2 weeks) 05 TanStack hooks + devtools + size-limit + Redis cascading
M5  Advanced     (ongoing)   06 WHIP/HLS/transcription/push/lobby — one PR per feature
1.0 Release
```

Dependencies: `M0 -> M1 -> M2` is linear (SFU needs relay; secure recording needs SFU). `M3` and `M4` can interleave after `M1`. `M5` is parallel tracks after `M2`.

## Milestone detail

### M0 — Foundations (must land first)

| Work | File | Done when |
|------|------|-----------|
| `Relay` interface + `RedisRelay` + `PostgresNotifyRelay` (dedicated `pg` client, NOT pool) + `attachWebSocketRelay({relay})` swap | `04-transport-signaling-scale.md §1` | 2-instance LB test passes; `LISTEN` single-client fix landed |
| Fix `types: dist/*.d.ts`, `files:["dist"]`, `exports["./package.json"]`, add `require` condition everywhere | `05-packaging-dx.md` | `publint` + `attw --pack` green |
| Add `rslib` ESM+CJS+dts-bundled for `protocol→transport→core` first, rest mechanical | `05` | `bun run build` still `tsc -b` typecheck, `rslib build` produces `dist/index.{js,cjs,d.ts}` |
| Token refresh `auth:{token,onTokenExpired}` + WS 4401→`auth:error` | `01-security.md` | `Room({auth})` + `GET /turn/credentials` coturn guide |

Accept: `bun run --filter '*' test --if-present` + Node 22 pinned; `size-limit` budgets set (core <15 kB gz).

### M1 — SFU Core

| Work | Done when |
|------|-----------|
| `MediaTransport` seam + `MeshMediaTransport` extraction (move `ensurePeer:970`/`peerFactory:984` inside) | `Room` no longer constructs `RTCPeerConnection` directly |
| `SfuMediaTransport` (1 PC to SFU) + `SfuRouter` wiring + `handleEnvelope sfu` (currently `break` `room.ts:889`) | 5-peer room uses single SFU PC (`topology:'auto'` threshold 4) |
| `MediaProcessor` chain + `publish({simulcast,svc,codecPreferences})` + `setPreferredLayers`/`requestKeyframe` vs `MediasoupAdapter` | simulcast `L3T3_KEY` demo + Safari H264 fallback |

Accept: `VIDCALL_MEDIASOUP_INTEGRATION=1` 5-peer integration test; no breaking change to `room.publish(track)` call sites.

### M2 — Secure + Recording product

| Work | Done when |
|------|-----------|
| SFrame processor (`RTCRtpScriptTransform` / insertable streams) + `RoomPolicy{e2eeRequired,locked,moderatorIds,maxParticipants}` + `Room.moderate` | `01-security.md` acceptance |
| `room.recording.start({mode:'sfu-selective'|'sfu-composite', layout, egress})` unified; `manifest.encrypted+keyId` | `02-recording.md` acceptance |
| SFU selective + composite reference egress (ffmpeg via PlainTransport) behind flag | Disk+S3 + TTL + Range download demo |

### M3 — Resilience

Composite `transport: SignalingTransport[]` sugar, `ReconnectingTransport` (backoff+replay via `listSignals`), `IceCoalescer` wiring, `docs/limits.md` matrix. `04 §3` acceptance: burst test doesn't trip Supabase/PG limits.

### M4 — DX & Scale polish

`roomOptions`/`participantsOptions` factories, `useRoomState(select)`, `useSuspenseRoomState`, `VidcallClient` dedup, `useChat`/`usePublish` mutations with optimistic echo, `@mbsks/openrtc-react-devtools` + `publint`/`attw`/`size-limit` CI gates, Redis SFU cascading `router.pipeToRouter`. `05` acceptance.

### M5 — Advanced (shippable one at a time)

WHIP/WHEP, HLS/RTMP egress, transcription (`transcript` envelope + `room.on('transcript')`), push/lobby/breakout/webhooks/CDR, `MediaProcessor` RNNoise/virtual-bg. Each is `06-advanced-media.md` isolated PR with its own `bun add` recipe.

## Breaking-change policy to 1.0

- `0.1.0` today is `private:true` not on npm (`package.json:2`). Use `changesets` (`CHANGELOG.md`, `.changeset/`) — every PR adds a changeset with `major|minor|patch` + migration note.
- Exports added are additive (`./express`, `./stores/*` subpaths keep). Renames (`recordingEndpoint` → `recording.endpoint`) keep alias until 1.0.
- `types: src` → `dist` is the only file-level breaking change before `M0` — do it once, with `publint` gate, before any `changeset publish`.
- `RoomConfig.transport: SignalingTransport | SignalingTransport[]` and `topology` are additive — single-transport call sites unchanged.
- 1.0 freezes `Envelope` `v:1` (`protocol/schema.json`); `v` bumps only on breaking wire change (docs `types.ts` rule). Unknown `type`/fields stay ignored+logged.

## Acceptance gates (every milestone)

- L0: `protocol/fixtures/*.json` + `quicktype` codegen → TS/Kotlin/Swift/Dart parity (single source `protocol/schema.json`).
- L1: `node --conditions=development --test` + `vitest run` (`transport`, `react`, `backend-*`) green.
- L2: `VIDCALL_MEDIASOUP_INTEGRATION=1` + 2-instance Redis relay integration (when landed).
- Publish: `are-the-types-wrong --pack` + `publint` + `changeset publish --dry-run` + `size-limit` budgets.
- Docs: each phase ships a `docs/guides/<feature>.md` + `examples/<feature>` or `integrations/<DB>.md` update.

## Effort & callouts

- M0 is mostly plumbing (weeks, not months) but is the load-bearing fix for every limiton the user listed: `ws.ts:58` RoomHub, `InMemoryStore.ts:14`, `chunker.ts:53` NOTIFY, `ws.ts:119` ICE burst, pre-release churn.
- Rust involvement: none through `M4`. Optional Rust signaling relay sidecar (`axum`/`tokio`) only if JS relay benchmarks fail at >50k concurrent WS — bookmarked in `00-overview.md`, not on critical path.
- `mediasoup` stays the SFU default (C++ worker, pinned `3.23.1` devDep type-only). Second adapter (LiveKit) proves `SfuGateway` generality without rewriting media in Rust.
