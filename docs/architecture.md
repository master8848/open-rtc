# vidcall — Architecture Blueprint (synthesized from research)

The big picture, in plain words: each person's app creates a `Room`, which
finds the other callers through a messaging channel you choose — Supabase,
Postgres, your own server, anything that can pass small JSON messages along.
Once introductions are made, browsers connect directly to each other and the
actual video flows peer-to-peer. All the fiddly parts of WebRTC — negotiation
races, message reordering, reconnects, quality drops — are handled inside the
engine, not in your app code. The rest of this document is the technical
blueprint of how that works.

> Status: draft v1, synthesized 2026-08-11 from `docs/research/webrtc-js.md`, `docs/research/backend-adapters.md`, `docs/research/mobile-bindings.md`. All policy from `CONTRIBUTING.md` applies (14-day dep age, exact pins, in-workspace sub-libs, ≥2 impls per interface, open-source docs).

## 1. Positioning

`vidcall` = a JS/TS library that lets vibe coders add video calling + reactions + a simple Zoom clone to any app in minutes, with the signaling/presence/state layer **pluggable** across backends (Supabase, Convex, Postgres, SQLite/libSQL, Appwrite, Firebase, + custom), and **native bindings** in Kotlin, Swift, Dart(Flutter) speaking the same wire protocol.

## 2. High-level architecture

```
App (vibe coder) ── vidcall public API (Room / LocalParticipant / RemoteParticipant / events)
        │
vidcall engine (in-workspace, dependency-light)
 ├─ SignalingTransport (adapter interface) ← backends: supabase | convex | firebase | appwrite | postgres | sqlite | custom
 ├─ PeerConnectionManager (mesh core: perfect negotiation, trickle ICE, renegotiation, ICE restart)
 ├─ AdaptiveQualityController (stats monitor → policy ladder → setParameters/applyConstraints/layer switch)
 ├─ DeviceCapability (hardwareConcurrency / deviceMemory / screen → initial caps)
 ├─ DataChannelBus (reactions / chat / control) + PresenceBus (backend-native)
 └─ hooks: RecordingHook, ScreenShare, KeyframeRequester
        │
optional: SfuGateway adapter (generic SFU protocol; reference impl; mediasoup/LiveKit integration guides)
          ^ scaffolding done in packages/sfu-gateway (interface + SfuRouter + mediasoup reference adapter);
            Room integration TODO (parent wires SfuGateway into Room)
```

## 3. Core decisions (from research)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Zero runtime deps in core** — build on platform `RTCPeerConnection`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | simple-peer stale (2023), peerjs cloud server not for prod; platform API is enough with perfect negotiation                                                                                                                                                                                                                         |
| D2  | **Mesh = core; SFU = optional `SfuGateway` interface** (not bundled). **Status:** `packages/sfu-gateway` landed — interface + `SfuRouter` envelope handling + mediasoup reference adapter, unit + real-worker integration tests green (see §4.1); wiring into `Room` is TODO |                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | mesh works over any dumb pub/sub, fine for 2-4 participants ("simple Zoom clone" tier); SFU add-on via reference impl + mediasoup/LiveKit guides                                                                                                                                                                                    |
| D3  | **JSON envelope over backend pub/sub**: `{v,type,roomId,senderId,sessionId,ts,seq}`; types `join/leave/offer/answer/ice/presence/reaction/chat/screen-share/quality-warning` + `sfu` (actions `publish/subscribe/layer-change/keyframe-request/leave`, §4.1)                                                                                                                                                                                                                                                                                                                                                       | one channel per room; engine owns ordering/idempotency/glare so backends stay dumb                                                                                                                                                                                                                                                  |
| D4  | **Backend adapters**: unified `SignalingBackend` TS interface (join/leave/emit/onMessage/onPresence/setPresence/dispose)                                                                                                                                                                                                                                                                                                                                                                                                                       | ≥2 impls per interface policy; matrix: Supabase (native broadcast+presence, default), Firebase RTDB (best ceiling, onDisconnect), Convex (realtime), Appwrite (one-way → doc-write signaling + heartbeat presence), Postgres (LISTEN/NOTIFY + 7KB chunker + ws bridge), SQLite/libSQL (same-device BroadcastChannel; dev/test only) |
| D5  | **Adaptive quality, 3 layers**: (a) device profile at join → initial caps; (b) native GCC/transport-CC (RFC 8888) → `availableOutgoingBitrate`; (c) policy engine on tier ladder with hysteresis (instant downgrade, 10s-stable upgrade), reacting to RTT/loss/bitrate + `qualityLimitationReason:'cpu'` + `totalEncodeTime` slope; applies `maxBitrate`/`scaleResolutionDownBy`/`degradationPreference`/simulcast layer drops; Safari falls back to single-stream H.264. Emits `quality:changed`/`quality:warning` `{from,to,reason:'network' | 'cpu'                                                                                                                                                                                                                                                                                                                               | 'device' | 'manual' | 'recovery',direction}` | network speed × device capability, with user-visible warnings |
| D6  | **Reactions/presence/chat/screen-share/recording**: backend pub/sub + one typed DataChannel (SCTP RFC 8831/8832); presence backend-native; recording = hook interface (MediaRecorder default, SFU-egress later)                                                                                                                                                                                                                                                                                                                                | zero extra infra                                                                                                                                                                                                                                                                                                                    |
| D7  | **Node test peers**: `@roamhq/wrtc@0.10.0` (native, real encode) + `werift@0.24.4` (pure TS, CI-friendly); policy engine pure (consumes `RTCStatsSnapshot`) → unit-testable without WebRTC                                                                                                                                                                                                                                                                                                                                                     | CI without browsers/native addons                                                                                                                                                                                                                                                                                                   |
| D8  | **Shared wire protocol**: one versioned JSON envelope defined as **JSON Schema + quicktype codegen → TS/Kotlin/Swift/Dart** (zero runtime deps); protobuf rejected (overkill for signaling)                                                                                                                                                                                                                                                                                                                                                    | single contract across 4 languages                                                                                                                                                                                                                                                                                                  |
| D9  | **Bindings**: Kotlin `io.getstream:stream-webrtc-android:1.3.10`, iOS community WebRTC pod `150.0.0`, Flutter `flutter_webrtc:1.5.2` (NOT webrtc_flutter — 404). Official backend SDKs: Supabase/Firebase/Appwrite on all 3 platforms; Convex has Kotlin+Swift but NO Dart (raw-WebSocket fallback); Postgres/SQLite need a TS-side signaling relay                                                                                                                                                                                            | verified publish dates ≥14d (2026-08-11)                                                                                                                                                                                                                                                                                            |
| D10 | **Testing**: L0 protocol conformance with shared fixtures (merge gate) → L1 unit → L2 cross-language integration; one `macos` runner covers iOS simulator + Android emulator (CI deferred — run locally for now)                                                                                                                                                                                                                                                                                                                                                 | shared matrix mandated by CONTRIBUTING.md                                                                                                                                                                                                                                                                                           |
| D11 | **Publishing**: Maven Central (Central Portal), SwiftPM-first (CocoaPods trunk going read-only ~2026), pub.dev verified publisher                                                                                                                                                                                                                                                                                                                                                                                                              | open-source distribution                                                                                                                                                                                                                                                                                                            |

## 4. Monorepo layout (npm workspaces)

```
vidcall/
├── packages/
│   ├── core/                  # engine: Room, PeerConnectionManager, protocol types (TS, no runtime deps)
│   ├── quality/               # AdaptiveQualityController + DeviceCapability (pure, RTCStatsSnapshot in/out)
│   ├── transport/             # SignalingTransport interface + helpers (chunker, reorder, heartbeat, ICE coalescer)
│   ├── backend-supabase/      # adapter (default)
│   ├── backend-convex/        # adapter
│   ├── backend-firebase/      # adapter
│   ├── backend-appwrite/      # adapter (doc-write signaling + heartbeat presence)
│   ├── backend-postgres/      # adapter (LISTEN/NOTIFY + chunker + optional ws bridge)
│   ├── backend-sqlite/        # adapter (libSQL; same-device BroadcastChannel; dev/test mode)
│   ├── sfu-gateway/           # SfuGateway interface + SfuRouter + mediasoup reference adapter (scaffolded; Room wiring TODO)
│   ├── kotlin/                # Kotlin binding (mirrors core, same protocol)
│   ├── swift/                 # Swift binding
│   └── dart/                  # Dart/Flutter binding
├── protocol/                  # JSON Schema + quicktype codegen (single source of truth)
├── examples/                  # vanilla (sqlite BroadcastChannel), react+supabase, express server (+ README)
├── e2e/                       # L2 integration + benchmarks (per-backend)
└── docs/                      # research/ (done), api/, guides/
```

### 4.1 SFU path (`packages/sfu-gateway`)

Landed (scaffolding milestone; `npm run build` + tests green):

```
packages/sfu-gateway/
├── src/
│   ├── sfu-gateway.ts        # SfuGateway/SfuSession contract (media-agnostic)
│   ├── sfu-router.ts         # protocol sfu-envelope handling, pure logic
│   ├── mediasoup-adapter.ts  # reference SfuGateway on a mediasoup Router
│   ├── sdp.ts                # minimal SDP<->mediasoup translation
│   └── events.ts             # typed emitter (in-workspace, leaf package)
└── test/                     # unit (fake gateway/router/transport) +
                              # env-gated real-worker integration
```

- **Contract**: `SfuGateway.join(roomId, participantId)` → `SfuSession` with
  `publishTrack` / `subscribe` / `setPreferredLayers` / `requestKeyframe` /
  `handleOffer` / `handleAnswer` / `addIceCandidate` / `leave`, plus
  `onTrack` events and `close(roomId?)`. SDP offers/answers and ICE
  candidates pass through untouched — adapters own the translation.
- **Envelope flow** (`SfuRouter.handle`, one per room): `sfu` envelopes
  (`publish` / `subscribe` / `layer-change` / `keyframe-request` / `leave`,
  protocol/schema.json `SfuPayload`) are validated against room membership,
  then forwarded to the sender's session; `offer`/`answer`/`ice` envelopes
  are consumed only when `targetSenderId` is the SFU participant id
  (default `'sfu'`). Everything else (mesh chat/reactions/presence) keeps
  flowing through the same backend untouched.
- **Mediasoup adapter** (reference): verified against the pinned mediasoup
  `3.23.1` API (`.d.ts`) and a real worker — `transport.connect({dtlsParameters})`
  only (no remote-ICE input), receiver-driven `consumer.requestKeyFrame()`,
  `ProducerOptions.keyFrameRequestDelay` via
  `PublishOptions.keyFrameRequestDelayMs`, `setPreferredLayers` maps
  `l/m/h` → spatial layers. `mediasoup` is a pinned devDependency
  (type-only import; runtime `dist` never loads the native module; worker
  needs Node >= 22). The integration test
  (`VIDCALL_MEDIASOUP_INTEGRATION=1`) passes against a real worker; unit
  tests run without one.
- **Room wiring is a TODO**: `Room` (packages/core) will construct one
  gateway per room, `join`+`registerSession` on participant join (SFU mode),
  route envelopes through `SfuRouter`, and forward `onTrack` events to
  subscriptions. Mesh stays the default; LiveKit would be a second adapter
  behind the same contract.

## 5. Build order (tomorrow, mapped to Reminders plan)

1. `protocol/` JSON Schema + codegen → core types (V2 scaffold, V3 core API)
2. `core/` engine: perfect negotiation + trickle ICE + renegotiation (V3)
3. `transport/` interface + helpers; `backend-supabase` first (V4), then postgres → convex → firebase → appwrite → sqlite
4. `quality/` policy engine + device profile + events (V5), Zoom-clone features on top (V6)
5. Bindings Kotlin → Swift → Dart mirroring core (V7-V9), L0 fixtures + CI matrix (V10)

## 6. Open items (from research, verify at implementation)

- Re-verify pin publish dates (packages ship weekly); Supabase per-publisher broadcast FIFO; Ably/Firebase/Turso pricing numbers.
- SFU: `packages/sfu-gateway` scaffolded (protocol `sfu` envelopes routed, mediasoup reference adapter compiled, integration env-gated and verified against a real worker — §4.1). TODO: wire `SfuGateway` into `Room` (create sessions on join, route envelopes, forward `onTrack` to subscriptions), plus a LiveKit adapter guide.
- Postgres NOTIFY: confirm relay design (browser clients need ws bridge; keep LISTEN on dedicated `pg` client, NOT pool).
- iOS Safari: no getDisplayMedia / no send-side simulcast / no VP9-AV1 / AEC quirks → capability-aware warnings in docs + engine.

## 7. Risks & mitigations

| Risk                                          | Mitigation                                                            |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Backend rate limits kill signaling under load | chunker + coalesce ICE; rate-limit emits per adapter; document limits |
| TURN cost/complexity                          | mesh default; document coTURN setup; SFU path for scale               |
| Native binding drift from JS core             | L0 conformance fixtures as merge gate; codegen from protocol/         |
| Supply-chain                                  | 14-day age gate re-run at publish; lockfiles committed                |
