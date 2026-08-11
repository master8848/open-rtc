# vidcall — JS WebRTC Ecosystem Research & Media Engine Blueprint

> **Status:** Research input for implementation (implementation blueprint for the next build day).
> **Scope:** JS/TS video-calling library for "vibe coders": pluggable signaling backends (Convex, Supabase, PostgreSQL, SQLite, Appwrite, Firebase…), video calling + reactions + simple Zoom clones, **adaptive quality switching driven by network speed AND device processing capability, with warnings emitted to the app**.
> **Policies applied (from `lib-prj/CONTRIBUTING.md`):** dependency publish-date ≥ 14 days (verified via npm registry `time.created`), exact version pins, prefer in-workspace sub-libraries over micro-deps, prefer base/std utilities, every adapter interface needs ≥ 2 implementations, docs written for open source with source links.
> **All facts below were verified against primary sources (W3C specs, MDN, npm registry, project repos) on the day this doc was written.** Publish dates are from `https://registry.npmjs.org/<pkg>` → `time.created`.

---

## 0. Executive summary & recommendations

| # | Decision | Recommendation |
|---|---|---|
| 1 | Browser engine | Build on the platform `RTCPeerConnection` API directly. No wrapper dependency for the core engine (simple-peer/peerjs are not used as deps; we implement the thin peer-management layer in-workspace). Optional shim `webrtc-adapter@9.0.6` only if legacy-browser coverage is ever required (prefix differences are mostly gone today). |
| 2 | Node.js test strategy | Primary test peer: **`@roamhq/wrtc@0.10.0`** (native addon binding libwebrtc M106, real encode/decode, browser-parity stats, prebuilt binaries, N-API v3). Secondary pure-JS option: **`werift@0.24.4`** (no native code, browser-compatible API, good for SDP/ICE/transport-level tests and CI without native addons). Both pass the 14-day supply-chain policy. |
| 3 | Architecture | **Mesh is core** (works over any generic pub/sub backend; zero media-server ops). **SFU support is an optional adapter surface**, not bundled: define a thin `SfuGateway` interface (publish/subscribe/layer-switch/keyframe) with a reference implementation; document mediasoup / LiveKit integration patterns. Do **not** depend on `mediasoup-client` or `livekit-client` in core. |
| 4 | Signaling | JSON envelope over the backend's own pub/sub (one channel per room). Types: `join/leave/offer/answer/ice/presence/reaction/chat/…`. Use the W3C **perfect negotiation** pattern (polite/impolite) + trickle ICE. No WebRTC-specific signaling server needed. |
| 5 | Adaptive quality | Three-layer design: (a) **device capability profile** at join (`hardwareConcurrency`, `deviceMemory`, screen size) → initial caps; (b) **native congestion control** (libwebrtc GCC over transport-wide CC, RFC 8888) → `availableOutgoingBitrate`; (c) **policy engine** that sets `maxBitrate`/`scaleResolutionDownBy`/`degradationPreference`, manages simulcast layers, and reacts to `qualityLimitationReason: 'cpu'`. Emits `quality:changed` events with a human-readable reason so apps can warn users. |
| 6 | Reactions/presence/chat/screen-share/recording | All ride the generic backend + DataChannel. Presence uses backend-native presence (Convex presence, Supabase presence, Firebase `onDisconnect`, Appwrite realtime). Recording is a **hook interface** (in-browser `MediaRecorder`, later SFU egress). |
| 7 | Biggest pitfalls | iOS Safari: no `getDisplayMedia`, no send-side simulcast, no VP9/AV1, limited simultaneous AV elements, AEC/echo quirks. TURN is required for symmetric NAT/firewalled users. Keyframe handling (PLI/FIR, layer-switch keyframes, join storms). |

**Headline architecture (see §8 for the full blueprint):**

```
App (vibe coder)  ──  vidcall public API (Room / LocalParticipant / RemoteParticipant / events)
        │
vidcall engine (in-workspace, dependency-light)
 ├─ SignalingTransport (adapter interface)  ← backends: convex | supabase | firebase | appwrite | postgres | sqlite | custom
 ├─ PeerConnectionManager (mesh core, perfect negotiation, trickle ICE, renegotiation)
 ├─ AdaptiveQualityController (stats monitor → policy → setParameters/applyConstraints/layer switch)
 ├─ DeviceCapability (hardwareConcurrency/deviceMemory/screen → initial caps + quality tier)
 ├─ DataChannelBus (reactions/chat/control envelopes)  +  PresenceBus (backend-native)
 └─ hooks: RecordingHook, ScreenShare, KeyframeRequester
        │
optional: SfuGateway adapter (generic SFU protocol; reference impl; mediasoup/LiveKit integration guides)
```

---

## 1. Browser WebRTC: the `RTCPeerConnection` API surface

Primary sources: [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/), [MDN RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection).

WebRTC in the browser is a **complete real-time media stack**: capture → encoding → SRTP → ICE/DTLS transport → congestion control, all inside the browser. The app/library only orchestrates it: negotiation (SDP), media track management, stats, and recovery. Nothing else in the JS ecosystem is needed to make P2P calls work — this is why the core engine can be dependency-free.

### 1.1 What the engine must manage

| Concern | Browser API | Engine responsibility |
|---|---|---|
| Capture | `navigator.mediaDevices.getUserMedia({audio, video})` | Requesting with sensible constraints; handling permission denial; stopping tracks on leave; reacting to `track.onended` (camera unplugged) |
| Track lifecycle | `pc.addTrack(track, stream)` / `pc.removeTrack(sender)` / `pc.addTransceiver(kind, init)` | Add/remove tracks; decide transceiver `direction` (`sendrecv/sendonly/recvonly/inactive`) |
| Negotiation | `createOffer()/createAnswer()/setLocalDescription()/setRemoteDescription()`, `negotiationneeded` event | Perfect-negotiation state machine (§4); renegotiation when tracks/parameters change; glare handling with `rollback` |
| ICE | `RTCConfiguration.iceServers`, `addIceCandidate()`, `icecandidate` event, `restartIce()` | STUN/TURN configuration injection; trickle-ICE forwarding over signaling; ICE restart on `failed` |
| DTLS/SRTP | automatic | Nothing to code — but must not break it (no custom muxing; keep `bundlePolicy`, unified-plan) |
| Media params | `RTCRtpSender.getParameters()/setParameters()` (`encodings[].maxBitrate`, `scaleResolutionDownBy`, `maxFramerate`, `active`, `rid`, `networkPriority`, `degradationPreference`), `RTCRtpTransceiver.setCodecPreferences()` | Adaptive quality (§5); codec preference (VP9/AV1 SVC where supported, H.264 fallback for Safari) |
| Capture constraints | `MediaStreamTrack.applyConstraints()` | CPU adaptation: lowering resolution/fps; screen-share resize |
| Stats | `pc.getStats()` (standard API; legacy removed in Chrome 117) | Adaptive quality policy engine (§5); call-quality events |
| Keyframes | RTCP PLI/FIR (automatic on packet loss); `RTCRtpScriptTransformer.generateKeyFrame()` (Chromium, encoded-transform API) | SFU layer-switch keyframe requests (§5.6, §7) |
| Data | `createDataChannel()` / `ondatachannel` | Reactions/chat/control channel (§6) |
| State | `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, and their `*change` events | Failure detection, ICE restart, reconnection UX |
| Screen share | `navigator.mediaDevices.getDisplayMedia()` | Screen-share track publication; **not available on iOS Safari** (§7) |
| Recording | `MediaRecorder` | Recording hooks (§6) |

### 1.2 State machines the engine observes

- `signalingState`: `stable → have-local-offer → stable` … (never `have-remote-offer`+`have-local-offer` at once if perfect negotiation is used; `closed`).
- `iceConnectionState`: `new → checking → connected/completed`, or `failed` (restart ICE), `disconnected` (transient, probe before restart).
- `connectionState`: aggregate of ICE+DTLS: `connecting/connected/disconnected/failed/closed` — this is the event apps should surface ("call reconnecting…").
- `iceGatheringState`: `new → gathering → complete` (trickle ICE means candidates stream in over time; do **not** wait for `complete` to signal).

### 1.3 Negotiation lifecycle (the heart of the engine)

The W3C-recommended **perfect negotiation** pattern ([MDN: Perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)) solves glare (both peers offering simultaneously) without a central arbiter:

1. Each peer computes `polite = myId < remoteId` (deterministic tie-break).
2. `negotiationneeded` → if `polite` or `makingOffer` is false → create offer, set local, signal.
3. On remote offer: `setRemoteDescription`; if we were mid-offer and we are the **impolite** peer, `rollback()` first, then answer; if we are polite, rollback and accept their offer.
4. Trickle ICE ([RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html)): forward each `icecandidate` as it fires; buffer remote candidates until `setRemoteDescription` has run (spec requires candidates to be added after remote description is set — queue them in the engine).

This pattern is the single most important correctness piece for a backend-agnostic engine, because signaling transport is only a message pipe — **all glare/ordering logic lives in the engine**, not the backend.

### 1.4 Stats API surface (see §5 for usage)

- Standard API: [`getStats()`](https://www.w3.org/TR/webrtc-stats/) returns a `Map<RTCStatsType, RTCStatsReport>`. Legacy `getStats(callback)` was removed in Chrome 117 ([migration guide](https://developer.chrome.com/blog/getstats-migration)).
- Key dictionaries: `outbound-rtp`, `inbound-rtp`, `candidate-pair`, `transport`, `remote-inbound-rtp`, `codec`, `data-channel`.

---

## 2. Node.js WebRTC options (testing the engine without a browser)

The engine targets browsers, but the media engine logic (signaling state machine, SDP handling, stats policy, adaptive controller) must be testable in Node. Two viable options, verified below.

### 2.1 `@roamhq/wrtc@0.10.0` — maintained fork of node-webrtc (native)

- **What:** Node.js native addon binding **libwebrtc M106** ([branch-heads/5249](https://webrtc.googlesource.com/src/+/branch-heads/5249)); aims for spec compliance, eventually WPT-tested. ([README](https://github.com/WonderInventions/node-webrtc/blob/master/README.md))
- **Packaging:** `npm install @roamhq/wrtc` pulls a prebuilt binary via optional platform packages (`@roamhq/wrtc-{linux|darwin|win32}-{x64|arm64}`); targets **N-API v3**; officially supported: Node 20 and 22 on Linux x64, macOS x64/arm64, Windows x64 (Linux arm64 marked uncertain in README table).
- **Nonstandard test APIs** (kept from node-webrtc, [docs/nonstandard-apis.md](https://github.com/WonderInventions/node-webrtc/blob/master/docs/nonstandard-apis.md)): `RTCAudioSource`/`RTCAudioSink`, `RTCVideoSource`/`RTCVideoSink` — **inject raw audio samples / I420 video frames** into a track; since it's real libwebrtc, the injected media is **actually encoded** (VP8/H.264) and can exercise DTLS, SRTP, congestion control, PLI/NACK, and `getStats()` end to end. Also `portRange` and `sdpSemantics: 'plan-b'` for legacy tests.
- **Supply chain:** created `2023-07-19` (✓ >14 days); latest `0.10.0`; BSD-2-Clause; active cadence (0.10.0 with M106 was a significant update; Windows binaries exist; issue tracker active).
- **Caveats:** it's a C++ addon (larger install, occasional CI crashes — see [libp2p/js-libp2p#3034](https://github.com/libp2p/js-libp2p/issues/3034) discussion of wrtc crashes in some test setups); libwebrtc M106 is older than current browsers (~2022 vintage) — simulcast/encoded-transform-era APIs may be missing; no camera/mic — use the nonstandard sources.
- Original `node-webrtc` npm package is effectively dead (latest tag `0.0.0`, [npm](https://www.npmjs.com/package/node-webrtc)); `@roamhq/wrtc` is the community-maintained reboot ([announcement discussion](https://news.ycombinator.com/item?id=37774807)).

### 2.2 `werift@0.24.4` — pure TypeScript, zero native code

- **What:** "WebRTC Implementation for TypeScript (Node.js)" — **browser-compatible `RTCPeerConnection` API** plus packet-level control. ([README](https://github.com/shinyoshiaki/werift-webrtc), [npm](https://www.npmjs.com/package/werift))
- **Implemented (verified from README):** full ICE (+ ICE-lite, ICE restart, ICE-TCP), STUN + **TURN client over UDP/TCP/TLS**, DTLS-SRTP, SCTP/DataChannel (ordered/unordered, partial reliability), RTP/RTCP (SR/RR, PLI, generic NACK, REMB, **transport-wide CC** with a sender-side bandwidth estimator), RTX/RED resilience, RTP payload helpers for VP8/VP9/H.264/AV1/Opus, **receive-side simulcast**, browser-compatible `getStats()`, and nonstandard helpers (`MediaRecorder`/WebM writer, MP4/WebM playback via `mediabunny`, dummy media-device sources). Node ≥ 16.
- **What it does NOT do:** OS camera/mic capture and **general-purpose media encoding are application concerns** — you feed it pre-encoded RTP or external encoders. (Its author's separate project `node-sfu` shows an SFU built on werift.)
- **Supply chain:** created `2020-08-01` (✓); MIT; very active (0.24.x line, `werift-rtp`, `werift-sctp` split packages).
- **Caveats:** encoding tests need an external encoder (see 2.4); it's a protocol reimplementation (not libwebrtc), so parity with browser quirks is approximate; WPT subset tracked in its own docs.

### 2.3 Comparison table

| Criterion | `@roamhq/wrtc` 0.10.0 | `werift` 0.24.4 |
|---|---|---|
| Type | Native addon (C++) | Pure TypeScript |
| Underlying engine | libwebrtc M106 | Own protocol implementation |
| Install footprint | Prebuilt binary (~20 MB class), N-API v3 | Small, no native |
| Node support | 20, 22 (README matrix) | ≥ 16 |
| Media encoding | **Yes** (from injected frames via `RTCVideoSource`) | No (feed pre-encoded RTP / external encoder) |
| Capture | None (inject via nonstandard APIs) | None (dummy sources in `nonstandard`) |
| SDP/ICE/DTLS/SRTP/SCTP | Yes (browser-grade) | Yes (reimplementation) |
| Bandwidth estimation | Yes (GCC) | Transport-CC estimator (sender side) |
| Simulcast | M106 era — not for tests | Receive-side; send via packet API |
| `getStats()` | Yes (browser parity) | Browser-compatible model |
| CI friendliness | Native binaries; occasional crash reports | Very good (pure JS) |
| License | BSD-2-Clause | MIT |
| Publish date | 2023-07-19 ✓ | 2020-08-01 ✓ |
| Repo | [WonderInventions/node-webrtc](https://github.com/WonderInventions/node-webrtc) | [shinyoshiaki/werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc) |

(For completeness, non-JS reference implementations used by the ecosystem: Go **pion/webrtc** and Rust **webrtc.rs** — relevant only if vidcall ever needs a native SFU side.)

### 2.4 Recommendation for vidcall's Node test strategy

1. **Default test peer: `@roamhq/wrtc@0.10.0` (devDependency, pinned).** It gives browser-parity negotiation, real encoding from injected frames, real ICE/DTLS/SRTP, and stats — the closest thing to a browser in Node. Use it for: signaling end-to-end tests, perfect-negotiation/glare tests, renegotiation tests, `getStats()`-driven policy tests (feed fake stats through the same code path).
2. **Pure-JS fallback: `werift@0.24.4` (devDependency, pinned).** Use for transport-level unit tests (SDP parse/emit, ICE candidate flow, DataChannel) and for CI jobs where native addons are problematic (e.g., minimal containers). Because werift can't encode, keep those tests media-agnostic (DataChannel + SDP) or inject pre-encoded RTP.
3. **Where the engine runs in tests:** the engine's browser-facing parts (`RTCPeerConnection` orchestration) should sit behind a thin `PeerFactory` seam so tests can inject a wrtc/werift peer. The policy engine (adaptive quality) should be **pure** — consume a `RTCStatsSnapshot` value object, not the live stats API — so unit tests can feed synthetic stats without any WebRTC implementation.
4. **Not for production:** neither package belongs in the runtime dependency graph of the browser library; both are dev-only.

---

## 3. P2P mesh vs SFU — what should be core vs optional

### 3.1 Mesh (pure P2P)

Each participant holds an `RTCPeerConnection` to every other participant. Costs per participant: **N−1 uplinks and N−1 downlinks** (bandwidth, encode/decode, memory). Benefits: no media server, no ops, no per-minute infra cost, works over any pub/sub signaling.

**Limits (well documented in the ecosystem):**
- Bandwidth: at 1.5 Mbps send per participant, a 4-person call needs ~4.5 Mbps upload per peer; above ~4–6 video participants it breaks on typical home connections.
- CPU: each participant encodes once but decodes N−1 streams.
- iOS Safari: cannot render many simultaneous AV elements reliably (WebKit bug reports, e.g. [WebKit bug 179363](https://bugs.webkit.org/show_bug.cgi?id=179363) "Multiple Simultaneous Audio or Video Streams … severely limiting", and community guidance in [WebRTC with Safari in the Wild](https://webrtchacks.com/guide-to-safari-webrtc/)) — mesh video beyond ~2–4 remote streams is unreliable on iPhone Safari.
- **Rule of thumb: mesh for 2–4 video participants, more for audio-only/data.** This is exactly what a "simple Zoom clone" MVP needs; a real Zoom needs an SFU.

### 3.2 Libraries compared

| | `simple-peer` 9.11.1 | `peerjs` 1.5.5 | `mediasoup` 3.24.2 (+`mediasoup-client` 3.21.0) | `livekit-client` 2.21.0 |
|---|---|---|---|---|
| Role | P2P peer abstraction (1:1) | P2P + signaling server + cloud | **Server-side SFU** library + thin browser client | Client SDK for **LiveKit SFU** (Go server) |
| Signaling | You build it (manual `signal` JSON) | Bundled PeerServer + public PeerJS cloud | **You build it** (explicitly no protocol; see [mediasoup docs](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)) | LiveKit's own WebSocket signaling protocol (requires LiveKit server) |
| Works with generic pub/sub backends? | Yes (any pipe) | Only PeerServer protocol | Yes for signaling (any pipe); media goes through the SFU | No — LiveKit protocol |
| Simulcast/SVC | Browser-native only (pass-through) | Browser-native only | First-class (see [scalability doc](https://mediasoup.org/documentation/v3/scalability/)) | First-class; **adaptive stream** (SDK auto-selects layer by element size/visibility + bandwidth, [docs](https://docs.livekit.io/transport/media/subscribe/)) |
| Recording/egress | No | No | Via app (server side) | Yes (Egress) |
| License | MIT | MIT | ISC | Apache-2.0 |
| Publish date / status | 2014-06-26; last release 2023-01 (stale; fork `@thaunknown/simple-peer` 10.1.2 modernizes) | 2013-03-25; slow cadence, still maintained ([issue #318](https://github.com/peers/peerjs/issues/318) "Is this project dead?") | 2016-01-01; very active | 2021-01-24; very active |
| Repos | [feross/simple-peer](https://github.com/feross/simple-peer) | [peers/peerjs](https://github.com/peers/peerjs) | [versatica/mediasoup](https://github.com/versatica/mediasoup) | [livekit/client-sdk-js](https://github.com/livekit/client-sdk-js) |

Other SFUs worth one line each: **Janus** (GPLv3, plugin-based, includes `videoroom`/recording), **Jitsi Videobridge** (Apache-2.0, COLIBRI protocol), **medooze** (Node SFU, notable AV1-SVC work: [Medooze on AV1 SVC chains](https://medooze.medium.com/mastering-the-av1-svc-chains-a4b2a6a23925)). See also [LiveKit vs Mediasoup](https://trembit.com/blog/livekit-vs-mediasoup/) and [SVC vs Simulcast](https://www.digitalsamba.com/blog/svc-vs-simulcast-in-webrtc) comparisons.

### 3.3 Recommendation for vidcall: mesh core + SFU-ready optional interface

**Core (shipped, dependency-free, works over every pluggable backend):**
- Mesh `PeerConnectionManager` (perfect negotiation, trickle ICE, renegotiation, ICE restart).
- Send-side adaptive quality (§5): simulcast where the browser supports it, single-stream bitrate/framerate/resolution control everywhere.
- Receive-side handling: remote track lifecycle, thumbnails/muting for CPU relief (mesh receive-side adaptation = mute/skip decoding, since there are no layers to pick in mesh).
- DataChannelBus (reactions/chat/control) + presence + recording hooks.

**Optional (adapter surface, not bundled):**
- A thin **`SfuGateway` interface** — the engine speaks a small, backend-agnostic media protocol on top of the same generic signaling: `publish(track)`, `subscribe(publicationId, layers)`, `setPreferredLayers`, `requestKeyframe`. This is deliberately *not* mediasoup's or LiveKit's wire protocol — it's vidcall's own contract so any SFU (mediasoup, LiveKit, Janus, custom) can be adapted.
- Reference adapters/guides (not core deps): mediasoup integration guide (server: your app + mediasoup workers; client: vidcall `SfuGateway` → your signaling → mediasoup), LiveKit integration guide (vidcall app uses `livekit-client` directly or through a thin adapter — note LiveKit owns the PeerConnection, so full engine features like custom backends don't apply there; LiveKit is a *platform*, not a pluggable-backend building block).
- Rationale: bundling `mediasoup-client`/`livekit-client` in core would couple vidcall to one SFU's protocol and signaling, contradicting the "pluggable everywhere" mandate; but shipping **no** SFU story would force users to throw the engine away at scale. The `SfuGateway` interface is the middle path, and it keeps the mesh → SFU migration path open for "simple Zoom clone" → "real Zoom clone".

---

## 4. Signaling protocol design (backend-agnostic)

Goal: **any** backend that offers pub/sub (or emulates it) can carry signaling. No WebRTC-specific server. The engine defines the wire contract; each backend adapter maps it onto its native primitives.

### 4.1 Message schema

Envelope (same shape for every message type, versioned):

```jsonc
{
  "v": 1,
  "type": "offer",                 // see table below
  "roomId": "room-abc",
  "senderId": "user-42",
  "sessionId": "call-session-7",    // per join; guards against stale tabs/duplicates
  "ts": 1730000000000,              // sender clock (for ordering/debug)
  "seq": 12,                        // per-sender sequence (ordering on unordered backends)
  "data": { /* type-specific payload */ }
}
```

| `type` | Direction | `data` payload | Notes |
|---|---|---|---|
| `join` | peer → room | `{displayName?, deviceCapability?, audio: bool, video: bool, mediaCapabilities?}` | Backend may also enforce auth/limits |
| `leave` | peer → room | `{}` | Also derived from presence expiry |
| `offer` | peer → peer | `{sdp, polite: bool, mid?: string, renegotiation?: boolean}` | Full SDP (unified-plan) |
| `answer` | peer → peer | `{sdp}` | |
| `ice` | peer → peer | `{candidate: {candidate, sdpMid, sdpMLineIndex, usernameFragment}}` | Trickle ICE ([RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html)) |
| `ice-restart` | peer → peer | `{}` (or bundled in offer) | Trigger `pc.restartIce()` + renegotiate |
| `presence` | peer → room | `{state: "joined"\|"connected"\|"away"\|"left", update: {...}}` | Heartbeat + backend-native presence where available |
| `reaction` | peer → room | `{emoji, targetParticipantId?, intensity?}` | Broadcast; rendered as overlay |
| `chat` | peer → room (or DM) | `{messageId, text, replyTo?}` | Also persisted by backend if desired |
| `screen-share` | peer → room | `{on: bool, trackId?, sourceId?}` | Followed by renegotiation/offer with the display track |
| `quality-warning` | peer → room (optional) | `{level, reason}` | App-level toast data (§5.5) — usually local, can be shared |
| `publish` / `subscribe` / `unsubscribe` / `layer-change` / `keyframe-request` | client ↔ SFU (via same pipe) | `{publicationId, trackId, layers, mode}` | SFU mode (§3.3); same envelope, same backend |
| `recording-state` | peer → room | `{on: bool, recorderId?}` | Recording hooks (§6) |

**SDP size note:** offers/answers are typically 3–10 KB; ICE candidates are small. All listed backends handle this easily.

### 4.2 Ordering, idempotency, glare — handled in the engine, not the backend

- Backends differ in ordering guarantees (Supabase Realtime broadcast is ordered per channel in most cases; Firebase RTDB is ordered by key; Convex is eventually consistent; SQLite relays are FIFO per connection). So the engine must be **order-tolerant**:
  - Buffer `ice` until the matching remote description is applied (`setRemoteDescription` first, then flush queued candidates).
  - Ignore duplicate offers/answers via `sessionId` + SDP `o=` line (`<session-id>` field) idempotency.
  - Perfect negotiation handles concurrent offers (glare) with `rollback` (§1.3, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)).
- `seq` per sender lets adapters on weakly-ordered backends drop stale messages; it is advisory, not required for correctness of the negotiation state machine.

### 4.3 Backend mapping table (each is a `SignalingTransport` adapter)

| Backend | Native realtime primitive | vidcall adapter approach | Presence |
|---|---|---|---|
| **Convex** | Reactive queries + mutations; presence component | Mutations for envelopes, query/subscription for room channel; [Convex realtime docs](https://docs.convex.dev/realtime); presence via [Convex presence component](https://www.convex.dev/components/presence) | Convex presence (live-updating room member list) |
| **Supabase** | Realtime (broadcast + presence + postgres_changes) over WebSocket | One broadcast channel per room (`room:{id}`), presence channel for members; [docs](https://supabase.com/docs/guides/realtime) | Realtime presence |
| **Firebase** | Realtime Database push + `onDisconnect` | Path per room (`rooms/{id}/msgs`), child_added fan-out; [docs](https://firebase.google.com/docs/database/web/read-and-write) | `onDisconnect` cleanup + heartbeat |
| **Appwrite** | Realtime events on collections | Envelope docs in a `calls` collection, subscribe to realtime; [docs](https://appwrite.io/docs/products/realtime) | Realtime presence via collection |
| **PostgreSQL** | `LISTEN/NOTIFY` ([docs](https://www.postgresql.org/docs/current/sql-notify.html)) via app-server WebSocket relay | App server bridges NOTIFY → WS; or use PostgREST/pgbouncer-level pub/sub in prod | Heartbeat rows / NOTIFY |
| **SQLite** | None (no push) | App-server WebSocket relay or polling adapter (documented as "polling mode" for local-first dev) | Polling heartbeat |

Requirement from CONTRIBUTING.md — **every adapter interface needs ≥ 2 implementations**: ship `convex`, `supabase`, `firebase`, `appwrite`, `postgres`, `sqlite` + a `custom` (user-provided `send/onMessage`) escape hatch.

### 4.4 Connection setup sequence (mesh, one room)

```
A: join(room)  ──────────────►  backend room channel (presence: A online)
B: join(room)  ──────────────►  presence: [A,B]
A: presence(joined) ─────────►  B sees A → A is polite? id compare
A: offer(sdpA) ──────────────►  B: setRemoteDescription(sdpA) → answer(sdpB)
B: answer(sdpB) ─────────────►  A: setRemoteDescription(sdpB)
A: ice(c1)…ice(cN) ──────────►  B: addIceCandidate (buffered until sdp applied)
B: ice(c1)…ice(cN) ──────────►  A: addIceCandidate
…DTLS handshake happens automatically… connectionState → 'connected'
A: reaction 👍 / chat / presence(away)  ──►  room broadcast
```

---

## 5. Adaptive quality: network speed × device capability, with warnings

This is the differentiator requested in the mission. Design principle: **the browser already has a world-class congestion controller (GCC); the engine's job is to (a) read its signals, (b) set sensible caps, and (c) convert observed degradation into user-facing warnings and proactive policy.**

### 5.1 Native bandwidth estimation — what the browser does for us

- Chromium/Firefox run **Google Congestion Control (GCC)**: delay-based + loss-based estimation driven by **transport-wide CC feedback** (RTCP feedback defined in [RFC 8888](https://www.rfc-editor.org/rfc/rfc8888.html)); the estimate is exposed as `availableOutgoingBitrate` on the selected `candidate-pair` stats ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats/availableOutgoingBitrate)).
- **REMB** (RTCP Receiver Estimated Maximum Bitrate, expired draft `draft-alvestrand-rmcat-remb`) is the older receiver-driven scheme; still seen in some SFU/older-stack contexts, but transport-CC (RFC 8888) is the modern path. werift implements both (README).
- The browser automatically reduces encoder bitrate toward the estimate. **The engine does not implement congestion control** — it *shapes* it: max-bitrate caps per layer, and layer/framerate/resolution decisions.
- Related specs: [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/), [webrtc-stats](https://www.w3.org/TR/webrtc-stats/).

### 5.2 The stats signals the policy engine consumes (`getStats`, ~1 Hz polling)

| Stat (dictionary) | Meaning | Used for |
|---|---|---|
| `candidate-pair.availableOutgoingBitrate` | GCC-estimated uplink capacity (bps) | **Network speed** — the primary input |
| `candidate-pair.currentRoundTripTime` | RTT (s) | Congestion (sustained RTT rise ⇒ downgrade) |
| `outbound-rtp.framesPerSecond`, `framesEncoded` | Actual encode rate | Verify fps targets; detect encoder stalls |
| `outbound-rtp.totalEncodeTime` | Cumulative encoder time | CPU load proxy (`ΔencodeTime / wall time` ≈ encode duty) |
| `outbound-rtp.qualityLimitationReason` | `'none' \| 'cpu' \| 'bandwidth' \| 'other'` — why the encoder degraded ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCOutboundRtpStreamStats/qualityLimitationReason)) | **Device processing capability** — the key CPU signal |
| `outbound-rtp.qualityLimitationDurations` | Map reason → cumulative ms ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCOutboundRtpStreamStats/qualityLimitationDurations)) | Persistent CPU limitation detection |
| `outbound-rtp.packetsSent`, `retransmittedPacketsSent`, `nackCount`, `pliCount`, `firCount` | Loss/retransmission activity | Congestion severity; keyframe behavior |
| `inbound-rtp.framesPerSecond`, `framesDecoded`, `framesDropped`, `jitter`, `packetsLost`, `pliCount`, `nackCount` | Receive quality | Receive-side warnings; SFU layer selection |
| `transport.selectedCandidatePairId` | Which pair is active | TURN vs direct diagnostics |
| `codec.mimeType`, `codec.encoderImplementation` | e.g. `video/VP9`, HW/SW encoder | Codec capability decisions (§5.4) |

(Standard stats API: [W3C webrtc-stats](https://www.w3.org/TR/webrtc-stats/); good practitioner write-ups: [webrtcHacks: Power-up getStats](https://webrtchacks.com/power-up-getstats-for-client-monitoring/), [bloggeek: Making sense of getStats](https://bloggeek.me/getstats/).)

### 5.3 Send-side adaptation: Simulcast (RID) and SVC (VP9/AV1)

**Simulcast** = sender encodes 2–3 *independent* streams (e.g. 1080p/720p/360p) with distinct RIDs; an SFU forwards one layer per subscriber. Wire specs: [RFC 8853](https://www.rfc-editor.org/rfc/rfc8853.html) (SDP `a=simulcast`), [RFC 8851](https://www.rfc-editor.org/rfc/rfc8851.html) (RID restrictions), [RFC 8852](https://www.rfc-editor.org/rfc/rfc8852.html) (RID SDES).

Engine setup (single track → 3 encodings):

```js
await sender.setParameters({
  ...sender.getParameters(),
  degradationPreference: 'balanced',
  encodings: [
    { rid: 'f', maxBitrate: 2_500_000, maxFramerate: 30 },
    { rid: 'h', scaleResolutionDownBy: 2.0, maxBitrate: 1_000_000, maxFramerate: 30 },
    { rid: 'q', scaleResolutionDownBy: 4.0, maxBitrate: 400_000,  maxFramerate: 15 },
  ],
});
```

**SVC** = single stream with layered encoding (temporal + spatial), negotiated via [W3C webrtc-svc](https://www.w3.org/TR/webrtc-svc/) (`scalabilityMode`, e.g. `'L2T2'` for VP9/AV1). Layer-up usually requires a keyframe on the new layer; SFUs drop layers for layer-down (zero cost).

**Browser capability matrix (2025-era, verified across sources: [antmedia browser support](https://antmedia.io/webrtc-browser-support/), [digital samba SVC vs Simulcast](https://www.digitalsamba.com/blog/svc-vs-simulcast-in-webrtc), [LiveKit simulcast intro](https://livekit.com/blog/an-introduction-to-webrtc-simulcast), [Safari guide](https://webrtchacks.com/guide-to-safari-webrtc/)):**

| Capability | Chrome/Edge | Firefox | Safari (macOS) | Safari (iOS) |
|---|---|---|---|---|
| VP8 | ✓ | ✓ | ✓ (WebRTC-only codec, Safari 12.1+ per [WebKit](https://webkit.org/blog/8672/on-the-road-to-webrtc-1-0-including-vp8/)) | ✓ |
| H.264 | ✓ (most builds) | ✓ | ✓ (default) | ✓ (default) |
| VP9 | ✓ | ✓ | ✗ (no WebRTC VP9) | ✗ |
| AV1 | ✓ (SW/HW) | ✓ (SW) | ✗ (no WebRTC AV1) | ✗ |
| **Simulcast send** | ✓ (VP8/H.264) | ✓ (VP8) | ✗ (single stream) | ✗ |
| Simulcast receive | ✓ | ✓ | partial/historically limited | partial/historically limited |
| **SVC (spatial)** | ✓ VP9/AV1 | ✗ (VP9 temporal only) | ✗ | ✗ |
| SVC (temporal) | ✓ | ✓ VP9 | limited | limited |
| `degradationPreference` | ✓ | ✓ | partial | partial |
| `scaleResolutionDownBy` | ✓ | ✓ | recent versions (feature-detect) | recent versions (feature-detect) |
| `RTCRtpScriptTransformer.generateKeyFrame` | ✓ | ✗ | ✗ | ✗ |

**Consequences for the engine:**
1. **Simulcast only helps in SFU mode.** In mesh, the sender adapts for the *worst* receiver (lowest common denominator) — so mesh send-side policy = adjust bitrate caps / resolution, and optionally turn off the high layer.
2. Safari senders: **no simulcast, H.264** — engine must fall back to single-stream bitrate adaptation for Safari users (still effective via caps + degradation).
3. Chrome senders with VP9/AV1: prefer **SVC** (`scalabilityMode`) in SFU mode (one stream, cheap layer drops); use `setCodecPreferences` to order codecs: Safari-safe order is `H.264 > VP8`; Chrome+Firefox+macOS order can put `VP9 > VP8 > H.264`.
4. Feature-detect `setParameters` fields before using them; wrap in capability helpers (in-workspace `rtcCapabilities.ts`).

### 5.4 CPU / device-capability adaptation

**Signals:**
- `qualityLimitationReason === 'cpu'` (persistent across windows via `qualityLimitationDurations`) — the encoder itself reports CPU pressure. This is the cleanest "device processing capability" signal and exists in Chromium/Firefox ([webrtcHacks](https://webrtchacks.com/power-up-getstats-for-client-monitoring/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCOutboundRtpStreamStats/qualityLimitationReason)).
- `totalEncodeTime` slope (encode duty cycle > ~0.6–0.8 sustained ⇒ degrade).
- Device profile at join:
  - `navigator.hardwareConcurrency` (widely supported) — logical cores.
  - `navigator.deviceMemory` (**Chrome/Edge only**, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory), [caniuse](https://caniuse.com/mdn-api_navigator_devicememory)) — approximate RAM in GB.
  - `screen.width × screen.height` / CSS viewport — display resolution.
  - `navigator.userAgentData.mobile` / platform — mobile heuristic.
  - (Future: WebCodecs `VideoEncoder` capabilities probe, supported in Safari 26+ per [testmuai](https://www.testmuai.com/learning-hub/webcodecs-browser-support/), but don't depend on it yet.)

**Actions (in order of preference / least disruptive first):**
1. Set `degradationPreference` per track kind — `'maintain-resolution'` for screen share, `'maintain-framerate'` for thumbnails/small tiles, `'balanced'` for main camera ([MDN setParameters](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters), [degradationPreference issue #2248](https://github.com/w3c/webrtc-pc/issues/2248)).
2. Lower `maxBitrate` per encoding (network) or `maxFramerate` (CPU-light).
3. Raise `scaleResolutionDownBy` via `setParameters` (needs a keyframe — see §5.6) or `track.applyConstraints({width, height, frameRate})` (pre-encode, no keyframe handshake needed; supported everywhere).
4. **CPU-heavy path:** drop the highest simulcast layer (`encodings[0].active = false`), reduce fps to 15, then resolution; on `qualityLimitationReason === 'cpu'`, do not wait for the network estimate.
5. **Receive-side (mesh):** pause decoding of off-screen/tiny remote tracks (`remoteTrack.enabled = false` or stop sink), i.e. a mini "adaptive stream" like LiveKit's ([LiveKit adaptive stream](https://docs.livekit.io/transport/media/subscribe/)) but implemented locally in mesh; in SFU mode, send `layer-change` with desired max layer.
6. Codec/hardware: prefer hardware encoders when available (`codec.encoderImplementation` often contains hardware hints); on low-end devices, prefer H.264 over VP9 (VP9 software encode is expensive), or AV1 only when HW-accelerated.

### 5.5 The quality-switching policy engine (algorithm sketch)

**Tier ladder** (app-configurable; per track kind): `4K > 1080p30 > 720p30 > 480p30 > 360p30 > 360p15 > audio-only`.

Inputs per poll tick (1 s): `rtt`, `bitrateEstimate`, `lossRate`, `jitter`, `qualityLimitationReason`, `encodeDuty`, `deviceScore`, `viewSize` (receive-side).

```
PolicyEngine.tick(snapshot):
  # 1. Network downgrade (fast, hysteresis on upgrade)
  if bitrateEstimate < tier.requiredBitrate * 1.15  or  rtt > 400ms  or  lossRate > 5%:
      downgradeTo(nextLowerTier, reason='network')
  elif qualityLimitationReason == 'cpu'  or  encodeDuty > 0.75:
      downgradeTo(nextLowerTier, reason='cpu')
  else:
      # upgrade only after stability window (no downgrade for >= 10s and headroom >= 25%)
      if stableSince(tier) > 10s and bitrateEstimate > tier.requiredBitrate * 1.25:
          upgradeTo(nextHigherTier, reason='recovery')

  # 2. Apply: mesh send-side
  if simulcastActive(sender):  set active layers per tier (drop high layers first on downgrade)
  else: set maxBitrate / maxFramerate / scaleResolutionDownBy per tier
  # 3. Apply: mesh receive-side
  for remoteTrack in smallOrHidden(viewSize): pauseDecoding(remoteTrack)
  # 4. SFU mode: send layer-change(publicationId, maxLayer=tier.layer) to gateway

  # 3. Emit warnings (only on actual tier change, with debounce)
  if tier != previousTier:
      emit('quality:changed', {
        participantId, trackId, from: previousTier, to: tier,
        reason: change.reason,          // 'network' | 'cpu' | 'device' | 'manual' | 'recovery'
        direction: tier < previousTier ? 'down' : 'up',
        stats: { bitrateEstimate, rtt, lossRate, qualityLimitationReason }
      })
```

**Warning UX contract (mission requirement):** the engine emits events; apps render toasts. Suggested copy: `"Video quality reduced — slow network"` (`network`, down), `"Video quality reduced — this device is struggling to encode"` (`cpu`, down), `"Video quality improved"` (`recovery`, up). Also expose `room.on('quality:warning', {level: 'info'|'warn'|'critical', message, data})` for app-level handling (e.g., a persistent badge for `audio-only` mode).

**Anti-oscillation rules:** immediate downgrade (≤ 2 bad ticks), delayed upgrade (≥ 10 s of headroom); upgrade only one tier at a time; downgrade may skip tiers on severe congestion (`audio-only` when RTT > 800 ms or estimate < 150 kbps).

### 5.6 Keyframe interplay (critical for layer switches)

- Changing `scaleResolutionDownBy` (and spatial SVC layer-up) requires a **keyframe** to be produced; browsers handle re-negotiated encode sizes, but SFU layer-up needs an explicit request ([fippo's setParameters explainer](https://fippo.github.io/webrtc-explainers/rtcrtpsender-setparameters/)).
- Mechanisms: RTCP **PLI** ([RFC 4585](https://www.rfc-editor.org/rfc/rfc4585.html)) and **FIR** ([RFC 5104](https://www.rfc-editor.org/rfc/rfc5104.html)) are sent automatically by receivers on loss/decode errors; for app/SFU-initiated requests use `RTCRtpScriptTransformer.generateKeyFrame()` (Chromium; [MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransformer/generateKeyFrame), [W3C webrtc-encoded-transform](https://www.w3.org/TR/webrtc-encoded-transform/)) or SFU-specific keyframe RTP (mediasoup `Consumer.requestKeyFrame()`). Expose a `requestKeyframe(publicationId)` on the SFU gateway and `keyframe-request` in signaling.
- **Join storms:** when many viewers join, requesting keyframes from all senders at once spikes encoder/network — stagger keyframe requests (jitter 0–1 s) and rely on RTX/PLI for loss recovery ([RFC 4588](https://www.rfc-editor.org/rfc/rfc4588.html) retransmission is automatic in browsers). SFUs with keyframe caching (LiveKit does this to fast-start subscribers) eliminate most of this pain.

---

## 6. Reactions, presence, chat, screen-share, recording hooks

All five features are **data-plane + control-plane patterns** that work over generic backends — none require WebRTC-specific infrastructure.

| Feature | Transport | Pattern | Backend hooks |
|---|---|---|---|
| **Reactions** | DataChannel (low latency, in-call) + backend broadcast (durable/offline) | Small envelope `{type:'reaction', emoji, target?, ts}` on the room channel; render as floating overlay; throttle (e.g. ≥ 250 ms between sends) | Same envelope via `SignalingTransport.send`; also fine via backend-only for non-WebRTC "reactions" |
| **Presence** | Backend-native presence (see table §4.3) | `join`/`leave` + heartbeat (30 s) + `onDisconnect` cleanup where supported; engine exposes `room.participants` reactive list | Convex presence, Supabase presence channel, Firebase `onDisconnect`, Appwrite realtime |
| **Chat** | DataChannel for delivery + backend for persistence | `{type:'chat', messageId, text, replyTo?}`; engine emits `room.on('chat')`; apps persist via backend CRUD | Any backend collection/table |
| **Screen share** | `getDisplayMedia` → new transceiver + renegotiation (mesh) or `publish` (SFU) | `screen-share` control message then offer with `sendrecv`→`sendonly` video track; receiver attaches to `track` event; `screen-share:off` on `track.onended` (user clicked "Stop sharing") | Signaling only; **unsupported on iOS Safari** (§7) |
| **Recording** | Hook interface, engine-agnostic | `RecordingHook` interface: `start(localStream|remoteStream, opts) / stop() / onData`; default impl uses **`MediaRecorder`** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)) on the composed stream; `recording-state` message notifies peers; SFU mode may delegate to egress (LiveKit Egress) | Backend optional (store blob/URL) |

**DataChannel design:** one engine-owned control channel per peer with typed envelopes (`{channel:'chat'|'reactions'|'control', ...}`), or separate channels per purpose. Prefer **one channel + typed envelopes** (fewer SCTP streams, simpler ordering); SCTP ([RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html), [RFC 8832](https://www.rfc-editor.org/rfc/rfc8832.html)) handles fragmentation (~64 KB max message, use JSON strings ≪ that). Use `bufferedAmount` for backpressure (don't spam reactions/chat faster than the channel drains).

---

## 7. Pitfalls (bake these into the engine + docs)

1. **STUN is not enough; TURN is required for a real product.**
   - STUN ([RFC 8489](https://www.rfc-editor.org/rfc/rfc8489.html)) handles most NATs; symmetric NATs and strict firewalls (hotel Wi-Fi, corp networks, some mobile carriers) need **TURN** ([RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)), which relays media through a server and costs bandwidth. Public STUN servers (e.g. `stun:stun.l.google.com:19302`, [community list](https://gist.github.com/zziuni/3741933), [metered list](https://www.metered.ca/blog/list-of-webrtc-ice-servers/)) are fine for dev; prod needs an app-configured TURN (coTURN is the standard OSS server). Engine must: inject `iceServers` from app config, surface `icecandidateerror`/`iceTransportPolicy:'relay'` fallback, and document "no TURN ⇒ ~10–20% of calls fail" ([bloggeek: When you NEED TURN](https://bloggeek.me/webrtc-turn/), [getstream STUN/TURN guide](https://getstream.io/resources/projects/webrtc/advanced/stun-turn/)).
2. **iOS Safari hard limits:**
   - **No `getDisplayMedia`** — screen share must be unsupported on iOS Safari (or native-extension based). Confirmed by platform gap discussions ([BigBlueButton #8576](https://github.com/bigbluebutton/bigbluebutton/issues/8576), [Chromium issue 40753589](https://issues.chromium.org/issues/40753589)).
   - **No send-side simulcast, no VP9/AV1, H.264-only encoding** (§5.3). SFUs must downscale/transcode for Safari or send H.264.
   - **Limited simultaneous AV playback** — multi-party video mesh breaks on iPhone Safari ([WebKit bug 179363](https://bugs.webkit.org/show_bug.cgi?id=179363), [SO: 2+ remote streams only 1 plays](https://stackoverflow.com/questions/56382110/webrtc-ios-safari-2-remote-streams-only-1-plays-back)); engine should cap/mix on iOS (canvas compositing or SFU-forwarded mixed streams).
   - `getUserMedia` requires a user gesture; camera/mic stop when the tab backgrounds; `playsinline` required on `<video>`; autoplay policies ([Apple: Delivering video content for Safari](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)).
3. **Echo / audio:**
   - Always request `echoCancellation: true` (plus `noiseSuppression`, `autoGainControl`) — the browser's AEC ([libwebrtc audio processing](https://webrtc.org/architecture/)) handles it; avoid playing remote audio near the mic.
   - Safari/iOS AEC quirks are real (echo at call start, after pause/mute — e.g. [webrtc/samples #1243](https://github.com/webrtc/samples/issues/1243) and the long tail of Safari echo reports); known workarounds: delay audio start a couple seconds after `getUserMedia`, re-toggle mute, restart audio track on echo complaints (community write-up: [dev.to: 5-second delay fix](https://dev.to/hamedhajiloo/how-i-fixed-a-web-audio-echo-problem-with-a-5-second-delay-384h)).
4. **Keyframes / join latency:** first video frame waits for a keyframe; lost keyframes freeze video until PLI triggers a new one; **join storms** (many keyframe requests at once) — stagger joins and/or use SFU keyframe caching; layer-up needs explicit keyframe (§5.6).
5. **Negotiation/glare:** never implement naive "offer on `negotiationneeded` + answer on offer" without the perfect-negotiation polite/impolite+`rollback` logic — it deadlocks under concurrent adds ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation), [webrtcHacks: Perfect negotiation](https://webrtchacks.com/min-duration-series-part-1-perfect-negotiation/)).
6. **ICE failure handling:** `failed` ⇒ `restartIce()` + renegotiate; `disconnected` ⇒ don't rip down the call — probe for a few seconds first; distinguish "no media" (stats frozen) from "no connection" (state machine).
7. **Codec negotiation:** without `setCodecPreferences`, Safari/Chrome can pick VP9 and Safari can't decode it — engine must order codecs by participant capabilities (H.264 fallback; Opus is the universal audio codec).
8. **Resource leaks in SPAs:** every `RTCPeerConnection` must be `close()`d, tracks `stop()`ped, event listeners removed, timers cleared, DataChannels closed on leave — a missed close leaks sockets/SRTP state (engine lifecycle tests).
9. **DataChannel backpressure:** large chat/reaction bursts fill SCTP buffers — use `bufferedAmount` and throttle; message size cap ~64 KB.
10. **mDNS/IPv6/private IP candidates:** modern Chrome/Edge hide host IPs with mDNS candidates; don't write code that assumes raw IP candidates; keep `bundlePolicy:'max-bundle'` and unified-plan (Plan B is dead — [MDN RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)).

---

## 8. Implementation blueprint (tomorrow's build plan)

### 8.1 Proposed npm workspace layout (vidcall monorepo)

```
vidcall/
├── packages/
│   ├── core/            # types, envelope schema, events (typed EventEmitter in-workspace), utils
│   ├── engine/          # browser media engine (zero runtime deps)
│   │   ├── src/rtc/           PeerConnectionManager, PeerFactory seam, negotiation, ICE
│   │   ├── src/quality/       StatsMonitor, PolicyEngine (pure), DeviceCapability, QualityTiers
│   │   ├── src/media/         capture, screen-share, track registry, keyframe requester
│   │   ├── src/bus/           DataChannelBus, PresenceBus
│   │   └── src/hooks/         RecordingHook (MediaRecorder default), EventHooks
│   ├── backends/         # SignalingTransport adapters: convex, supabase, firebase, appwrite,
│   │                     #   postgres, sqlite, custom  (≥2 impls required by policy ✓)
│   ├── sfu/              # OPTIONAL SfuGateway interface + reference impl + mediasoup/livekit guides
│   └── bindings/         # Kotlin / Swift / Dart (wire protocol contract; later milestone)
├── docs/                 # this research + API docs
└── examples/             # react example, vanilla example, node-test example
```

### 8.2 Key interfaces (sketch)

```ts
// core
interface SignalingTransport {
  join(roomId: string, profile: ParticipantProfile): Promise<void>;
  leave(): Promise<void>;
  send(msg: Envelope): Promise<void>;           // unicast or broadcast per msg.target
  onMessage(cb: (msg: Envelope) => void): () => void;
  presence: PresenceProvider;                    // backend-native presence
}

interface PresenceProvider {
  onParticipants(cb: (list: Participant[]) => void): () => void;
  heartbeat(intervalMs?: number): void;          // with onDisconnect cleanup where available
}

// engine
interface MediaEngine {
  start(room: RoomConfig): Promise<Room>;
  publish(track: MediaStreamTrack, opts?: PublishOptions): Promise<TrackPublication>;
  // adaptive quality
  on(event: 'quality:changed' | 'quality:warning', cb: (e: QualityEvent) => void): () => void;
  setQualityTier(tier: QualityTier, reason?: 'manual'): Promise<void>;   // manual override
}

interface SfuGateway {                            // optional adapter
  publish(publicationId: string, track: MediaStreamTrack): Promise<void>;
  subscribe(publicationId: string, layers?: LayerRange): Promise<RemoteTrack>;
  setPreferredLayers(publicationId: string, layers: LayerRange): Promise<void>;
  requestKeyframe(publicationId: string): Promise<void>;
}
```

### 8.3 Dependencies & supply-chain record (all verified ≥ 14 days old; pin exact)

| Package | Version to pin | Role | `time.created` | License | Why |
|---|---|---|---|---|---|
| `@roamhq/wrtc` | `0.10.0` | devDependency (Node test peer) | 2023-07-19 ✓ | BSD-2-Clause | Browser-parity WebRTC in Node for engine tests |
| `werift` | `0.24.4` | devDependency (pure-JS test peer) | 2020-08-01 ✓ | MIT | Native-free WebRTC for CI/transport tests |
| `webrtc-adapter` | `9.0.6` | optional (not in core) | 2014-10-17 ✓ | BSD-3-Clause | Only if legacy-browser shims ever needed |
| `mediasoup` / `mediasoup-client` | `3.24.2` / `3.21.0` | optional SFU reference | 2016-01-01 ✓ | ISC | Reference SFU for integration guide/tests |
| `livekit-client` | `2.21.0` | optional SFU reference | 2021-01-24 ✓ | Apache-2.0 | LiveKit integration guide |
| `simple-peer` / `peerjs` | — | **not deps** (reference only) | 2014-06-26 / 2013-03-25 ✓ | MIT | Studied for design; we implement in-workspace |
| `sdp-transform` | — | not needed (in-workspace SDP helpers) | 2013-07-27 ✓ | MIT | Policy: prefer in-workspace helpers |
| `mediabunny` | `1.53.0` | optional (werift media) | 2025-06-16 ✓ | MPL-2.0 | Pure-TS media toolkit for werift pipelines |

**Runtime dependency count for `packages/engine`: 0.** All media logic uses platform Web APIs. Backends use each backend's official client (Convex, Supabase, Firebase, Appwrite SDKs — the app's choice, injected via the `SignalingTransport` adapter).

### 8.4 Test matrix (mandated by CONTRIBUTING.md: shared across bindings)

1. **Unit:** policy engine with synthetic `RTCStatsSnapshot` (pure, no WebRTC), envelope schema, presence heartbeat, backpressure throttling.
2. **Integration (Node, wrtc + werift):** perfect negotiation incl. glare, trickle ICE ordering/buffering, renegotiation on track add/remove, ICE restart, DataChannel chat/reactions, `quality:changed` emission on synthetic congestion.
3. **Browser (Playwright matrix):** Chromium (VP9 SVC, simulcast, `generateKeyFrame`), Firefox (VP8 simulcast, VP9 temporal), Safari macOS (H.264, no-simulcast fallback path). Test both mesh and SFU-gateway paths.
4. **Backend adapters:** contract tests run against each backend (Convex/Supabase/Firebase/Appwrite dev instances, Postgres NOTIFY relay, SQLite polling) asserting the same envelope round-trips.

---

## 9. Source index (all cited above)

**Specs & standards:** [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/) · [webrtc-stats](https://www.w3.org/TR/webrtc-stats/) · [webrtc-svc](https://www.w3.org/TR/webrtc-svc/) · [webrtc-encoded-transform](https://www.w3.org/TR/webrtc-encoded-transform/) · [RFC 8445 ICE](https://www.rfc-editor.org/rfc/rfc8445.html) · [RFC 8838 trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html) · [RFC 8853 simulcast](https://www.rfc-editor.org/rfc/rfc8853.html) · [RFC 8851 RID framework](https://www.rfc-editor.org/rfc/rfc8851.html) · [RFC 8852 RID SDES](https://www.rfc-editor.org/rfc/rfc8852.html) · [RFC 8888 transport-CC feedback](https://www.rfc-editor.org/rfc/rfc8888.html) · [RFC 8699 coupled CC](https://www.rfc-editor.org/rfc/rfc8699.html) · [RFC 4585 AVPF/PLI](https://www.rfc-editor.org/rfc/rfc4585.html) · [RFC 5104 codec control/FIR](https://www.rfc-editor.org/rfc/rfc5104.html) · [RFC 8831 data channels](https://www.rfc-editor.org/rfc/rfc8831.html) · [RFC 8832 DCEP](https://www.rfc-editor.org/rfc/rfc8832.html) · [RFC 8489 STUN](https://www.rfc-editor.org/rfc/rfc8489.html) · [RFC 8656 TURN](https://www.rfc-editor.org/rfc/rfc8656.html) · [RFC 7741 VP8 RTP](https://www.rfc-editor.org/rfc/rfc7741.html) · [RFC 7742 WebRTC video processing & codec requirements](https://www.rfc-editor.org/rfc/rfc7742.html) · [RFC 9628 VP9 RTP](https://www.rfc-editor.org/rfc/rfc9628.html) · [RFC 6190 H.264 SVC RTP](https://www.rfc-editor.org/rfc/rfc6190.html) · [AV1 RTP payload (AOMedia spec)](https://aomediacodec.github.io/av1-rtp-spec/v1.0.0.html)

**MDN:** [RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection) · [setParameters](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters) · [qualityLimitationReason](https://developer.mozilla.org/en-US/docs/Web/API/RTCOutboundRtpStreamStats/qualityLimitationReason) · [qualityLimitationDurations](https://developer.mozilla.org/en-US/docs/Web/API/RTCOutboundRtpStreamStats/qualityLimitationDurations) · [availableOutgoingBitrate](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats/availableOutgoingBitrate) · [generateKeyFrame](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransformer/generateKeyFrame) · [perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) · [getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) · [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) · [deviceMemory](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory) · [legacy getStats migration](https://developer.chrome.com/blog/getstats-migration)

**Ecosystem:** [@roamhq/wrtc npm](https://www.npmjs.com/package/@roamhq/wrtc) & [README](https://github.com/WonderInventions/node-webrtc/blob/master/README.md) · [werift npm](https://www.npmjs.com/package/werift) & [README](https://github.com/shinyoshiaki/werift-webrtc) · [simple-peer](https://github.com/feross/simple-peer) · [peerjs](https://github.com/peers/peerjs) · [mediasoup](https://github.com/versatica/mediasoup) & [scalability](https://mediasoup.org/documentation/v3/scalability/) & [no-signaling-protocol](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) · [livekit-client](https://github.com/livekit/client-sdk-js) · [LiveKit adaptive stream](https://docs.livekit.io/transport/media/subscribe/) · [LiveKit simulcast intro](https://livekit.com/blog/an-introduction-to-webrtc-simulcast) · [webrtchacks: Safari in the Wild](https://webrtchacks.com/guide-to-safari-webrtc/) · [webrtchacks: Power-up getStats](https://webrtchacks.com/power-up-getstats-for-client-monitoring/) · [webrtchacks: Perfect negotiation](https://webrtchacks.com/min-duration-series-part-1-perfect-negotiation/) · [antmedia browser support](https://antmedia.io/webrtc-browser-support/) · [digital samba SVC vs Simulcast](https://www.digitalsamba.com/blog/svc-vs-simulcast-in-webrtc) · [bloggeek: getStats](https://bloggeek.me/getstats/) · [bloggeek: SVC](https://bloggeek.me/webrtcglossary/svc/) · [bloggeek: TURN](https://bloggeek.me/webrtc-turn/) · [getstream STUN/TURN](https://getstream.io/resources/projects/webrtc/advanced/stun-turn/) · [fippo setParameters explainer](https://fippo.github.io/webrtc-explainers/rtcrtpsender-setparameters/) · [Medooze AV1 SVC](https://medooze.medium.com/mastering-the-av1-svc-chains-a4b2a6a23925) · [libp2p wrtc eval #3034](https://github.com/libp2p/js-libp2p/issues/3034) · [HN: updated node-webrtc](https://news.ycombinator.com/item?id=37774807)

**Backends:** [Convex realtime](https://docs.convex.dev/realtime) · [Convex presence](https://www.convex.dev/components/presence) · [Supabase Realtime](https://supabase.com/docs/guides/realtime) · [Firebase RTDB](https://firebase.google.com/docs/database/web/read-and-write) · [Appwrite Realtime](https://appwrite.io/docs/products/realtime) · [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)

**Pitfalls:** [WebKit bug 179363 (iOS multi-stream)](https://bugs.webkit.org/show_bug.cgi?id=179363) · [SO: iOS 2+ remote streams](https://stackoverflow.com/questions/56382110/webrtc-ios-safari-2-remote-streams-only-1-plays-back) · [BigBlueButton getDisplayMedia #8576](https://github.com/bigbluebutton/bigbluebutton/issues/8576) · [Chromium iOS screen capture issue](https://issues.chromium.org/issues/40753589) · [webrtc/samples echo #1243](https://github.com/webrtc/samples/issues/1243) · [echo workaround write-up](https://dev.to/hamedhajiloo/how-i-fixed-a-web-audio-echo-problem-with-a-5-second-delay-384h) · [Apple: video content for Safari](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari) · [caniuse deviceMemory](https://caniuse.com/mdn-api_navigator_devicememory) · [free STUN list](https://gist.github.com/zziuni/3741933) · [metered ICE servers](https://www.metered.ca/blog/list-of-webrtc-ice-servers/)
