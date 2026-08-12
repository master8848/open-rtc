# vidcall — Competitive Gap Analysis vs. Open-Source Video-Calling Projects

> **Status:** research output (input for roadmap/tickets).
> **Date:** 2026-08-12 · **Author:** gap-analysis agent (read-only of the codebase except this file).
> **Method:** GitHub API + READMEs + protocol/feature docs of 7 real OSS projects (fetched live on
> 2026-08-12; repo metadata via `api.github.com/repos`); codebase read at `docs/architecture.md`,
> `docs/research/*.md`, `protocol/schema.json`, `packages/{core,quality,transport,server}`,
> `packages/backend-*`, `packages/{kotlin,swift,dart}`. All repo facts below were re-verified from
> primary sources (repo pages, `README.md`, protocol docs) on the date above; stars/forks are
> snapshot values, not claims about quality.

---

## 0. TL;DR — top 8 gaps

| # | Gap | Sev | Reference | Where |
|---|---|---|---|---|
| 1 | Adaptive-quality policy exists but is **never applied** to live senders (no `setParameters`/`applyConstraints`/simulcast-layer switching, no `getStats()` loop) | must | LiveKit adaptive stream + dynacast; Galene bitrate caps | `packages/core/src/` (new `quality-bridge.ts`) |
| 2 | **No device-management API** (enumerate/switch/`facingMode`/restart) in any binding | must | LiveKit `Room.getLocalDevices`/`switchActiveDevice`; Galene device menu | `packages/core/src/devices.ts` + all bindings |
| 3 | **Unicast targeting not in the wire schema**; TS uses `targetSenderId`, Kotlin uses a transport-level `targetSessionId`, Swift/Dart have none → mesh >2 peers is inconsistent across bindings | must | mobile-bindings.md §2.2 (`to`); Galene `dest` | `protocol/schema.json` + all 4 mirrors |
| 4 | **Swift WebRTC layer is a stub** (binary target commented out; `VidcallWebRTC` compiles to a stub) | must | LiveKit/Jitsi ship real iOS SDKs | `packages/swift/Package.swift` |
| 5 | **Dart has no multi-peer mesh** (`VidcallRtcSession` = one `RTCPeerConnection`) → no group calls | must | vidcall JS `Room`; LiveKit Room | `packages/dart/lib/src/webrtc/rtc_mesh.dart` |
| 6 | **No server-side auth/tokens** — any client can join any room | must | LiveKit JWT; OpenVidu tokens; Galene auth | `packages/server/src/auth.ts` |
| 7 | **No SFU story implemented** (`packages/sfu-gateway/` promised in architecture.md, absent; `sfu` envelopes dead on the wire) | should | LiveKit; mediasoup-demo; Janus videoroom | new `packages/sfu-gateway/` |
| 8 | **No runnable examples** (`examples/` in architecture.md §4 doesn't exist) | should | mediasoup-demo; LiveKit Meet; OpenVidu tutorials | new `examples/{vite-react,node,zoom-clone}` |

Full list with file-level suggestions: §5. Leftover ticket-ready tasks: §6.

---

## 1. Competitive landscape (7 projects, mix of mesh + SFU)

| Project | Repo(s) | License | Core language(s) | Architecture | Signaling | Primary API style |
|---|---|---|---|---|---|---|
| **LiveKit** | livekit/livekit · livekit/client-sdk-js (plus Swift/Kotlin/Flutter SDKs) | Apache-2.0 | Go (server, on Pion); TS/Swift/Kotlin/Dart (SDKs) | **SFU** (distributed, single binary) | protobuf over WebSocket + JWT | `Room` / `LocalParticipant` / `RemoteParticipant` / `TrackPublication`, event-driven; declarative UI SDKs |
| **PeerJS** | peers/peerjs · peers/peerjs-server | MIT | TS (browser lib + Node server) | **Mesh** P2P (1:1 calls; groups via N connections) | JSON over WS (PeerServer id registry + relay) | `Peer` / `Call` / `DataConnection`, minimal callbacks |
| **OpenVidu** | OpenVidu/openvidu (openvidu-browser in-monorepo) | Apache-2.0 | TS (SDKs), Java (server), Kurento (media) | **SFU** via Kurento Media Server | OpenVidu RPC over WS + REST + tokens | `OpenVidu` / `Session` / `Publisher` / `Subscriber` / `StreamManager` + events; Angular components |
| **Galene** | jech/galene | MIT | Go (server + static web client) | **SFU** (VP8/VP9/AV1/H264, SVC on VP9, server-side recording) | symmetric JSON over WS (galene-protocol.md); SDP/ICE relayed | protocol-driven; URL/group model; admin + client JS |
| **mediasoup-demo** | versatica/mediasoup-demo (mediasoup, mediasoup-client) | ISC | TS (client); Node + C++ (mediasoup worker) | **SFU** (mediasoup) | custom JSON over WS (app-owned; demo implements it) | low-level `Device` / `Transport` / `Producer` / `Consumer` |
| **Janus** | meetecho/janus-gateway | GPL-3.0 | C | **SFU** (videoroom plugin; more plugins) | Janus API JSON over WS/REST (sync + async), plugin handles | attach/detach plugin handles; videoroom publish/subscribe |
| **Jitsi Meet** | jitsi/jitsi-meet · jitsi/lib-jitsi-meet · jitsi/jitsi-videobridge | Apache-2.0 | TS (app/SDK); Kotlin (JVB); XMPP (Prosody) | **SFU** (JVB, COLIBRI) + XMPP focus | COLIBRI/XMPP | full app + iframe API + low-level `JitsiConnection` / `JitsiConference` / `JitsiTrack` |

Snapshot repo metadata (fetched 2026-08-12): livekit/livekit 20.3k★ Apache-2.0 Go · peers/peerjs 13.4k★ MIT TS ·
OpenVidu/openvidu 2.1k★ Apache-2.0 TS · jech/galene 1.4k★ MIT Go · versatica/mediasoup-demo 1.3k★ ISC TS ·
meetecho/janus-gateway 9.1k★ GPL-3.0 C · jitsi/jitsi-meet 29.7k★ Apache-2.0 TS · jitsi/jitsi-videobridge 3.1k★ Apache-2.0 Kotlin.

---

## 2. Feature matrix

Legend: ✅ implemented · ⚠️ partial/app-level · ❌ absent (in the OSS project itself; apps may add it).

| Feature | vidcall (current) | LiveKit | PeerJS | OpenVidu | Galene | mediasoup-demo | Janus videoroom | Jitsi Meet |
|---|---|---|---|---|---|---|---|---|
| 1:1 calls | ✅ mesh | ✅ SFU | ✅ mesh | ✅ SFU | ✅ SFU | ✅ SFU | ✅ SFU | ✅ SFU |
| Multi-user group calls | ✅ mesh (2–4 realistic) | ✅ SFU (100s) | ⚠️ N mesh conns, no mgmt | ✅ SFU | ✅ SFU | ✅ SFU | ✅ SFU | ✅ SFU |
| Mute (local + remote) | ⚠️ local `track.enabled`/unpublish; no remote-mute | ✅ | ⚠️ app-level | ✅ | ✅ + remote mute by op | ⚠️ local only | ✅ | ✅ + moderator |
| Camera on/off | ⚠️ publish/unpublish only | ✅ | ⚠️ app-level | ✅ | ✅ | ⚠️ local | ⚠️ app-level | ✅ |
| Screen share | ⚠️ `announceScreenShare` + publish; **no capture helper** | ✅ `setScreenShareEnabled` | ⚠️ app-level | ✅ | ✅ | ✅ | ✅ (publisher) | ✅ |
| Recording | ✅ client-side MediaRecorder composite → server storage (Disk/S3) | ✅ server-side Egress (SFU) | ❌ | ✅ server-side (composited) | ✅ server-side (files) | ❌ (demo) | ✅ server-side (.mjr→webm) | ✅ Jibri |
| Adaptive quality (network + CPU) | ⚠️ **policy engine exists but unwired** (`packages/quality`, pure) | ✅ adaptive stream + dynacast + simulcast/SVC | ❌ | ✅ network-quality events | ⚠️ bitrate caps / throughput | ⚠️ simulcast/SVC layers (manual) | ✅ bitrate caps + FIR | ✅ simulcast + bandwidth estimation |
| Presence | ✅ backend-native per adapter | ⚠️ attributes + speaker events | ❌ | ✅ participants list | ✅ user list | ❌ | ❌ | ✅ participants |
| Reactions (emoji) | ✅ `reaction` envelope + data channel (TS) | ✅ data messages | ❌ | ⚠️ signals | ❌ | ❌ | ❌ | ✅ |
| Raise hand | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Chat | ✅ `chat` envelope (+peer-addressed) | ✅ data messages | ⚠️ data conns | ✅ text messages | ✅ + history | ✅ (data channel) | ⚠️ data channel | ✅ + private chat + polls |
| Device selection/switch | ❌ | ✅ (`getLocalDevices`, `switchActiveDevice`, `restartTrack`) | ❌ | ✅ switch camera | ✅ camera/mic menu | ⚠️ constraints | ⚠️ app-level | ✅ |
| E2EE | ❌ | ✅ insertable streams | ❌ | ⚠️ (paid tiers) | ❌ | ✅ (e2eKey) | ✅ | ✅ |
| Auth/tokens | ❌ (server accepts any join) | ✅ JWT | ⚠️ PeerServer ids | ✅ tokens | ✅ passwords/tokens | ⚠️ demo | ✅ pins/tokens | ✅ tokens |
| Virtual backgrounds / filters | ❌ | ✅ (SDK-side) | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Speaker detection | ❌ | ✅ `ActiveSpeakersChanged` | ❌ | ✅ speech detection | ⚠️ audio levels | ❌ | ⚠️ audiolevel events | ✅ speaker stats |
| Data channel API | ✅ `DataChannelBus` (TS only) | ✅ | ✅ | ⚠️ signals | ✅ | ✅ | ✅ | ✅ |
| Server component | ✅ REST+WS relay, 4 stores, recording storage | ✅ full server | ✅ PeerServer | ✅ full server | ✅ full server | ✅ demo server | ✅ gateway | ✅ full stack |
| Pluggable signaling backends | ✅ 6 adapters + InMemory + custom | ❌ (LiveKit protocol only) | ⚠️ PeerServer only | ❌ | ❌ | ❌ | ❌ | ❌ |
| Native mobile bindings | ✅ Kotlin / Swift / Dart (mesh; Dart single-peer) | ✅ Swift/Kotlin/Flutter | ⚠️ community | ✅ Android/iOS/RN | ⚠️ web-focused | ❌ | ⚠️ plugins | ✅ Android/iOS/RN/Flutter |
| Zero-runtime-dep core | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 3. Project profiles (what to borrow from each)

### 3.1 LiveKit — the feature-completeness bar (SFU, Apache-2.0)
Go SFU (Pion) + SDKs in JS/Swift/Kotlin/Flutter. Signaling is **protobuf over WebSocket with JWT
auth**; the server owns rooms/participants/tracks and pushes state. Client SDK API:
`Room` (connect/events) → `LocalParticipant.setCameraEnabled/setMicrophoneEnabled/setScreenShareEnabled`,
`publishTrack(track, {simulcast, source, name})`, `RemoteParticipant.getTrackPublication`,
`RoomEvent.ActiveSpeakersChanged`, `Room.getLocalDevices` / `room.switchActiveDevice` /
`track.restartTrack({facingMode})`. Quality features that matter for vidcall:
**adaptive stream** (receive-side: auto-unsubscribe/subscribe layers by video-element size/visibility),
**dynacast** (send-side: only publish layers others currently need), **selective subscription**,
**speaker detection**, **E2EE** (insertable streams), **Egress** recording, webhooks,
moderation/permissions. Client deps are heavy (SDK + platform WebRTC); the server is a full
platform, not pluggable.

### 3.2 PeerJS — the simplicity bar (mesh, MIT)
`new Peer(id)` → `peer.call(remoteId, stream)` / `peer.connect(remoteId)`; PeerServer (self-host or
cloud) is a JSON-over-WS id registry + relay. Deliberately minimal: no presence, chat, reactions,
recording, quality, or device APIs — the app builds them. This validates vidcall's choice of a mesh
core (`Room` + `PeerConnectionManager`) and a *tiny* signaling surface; PeerJS's gaps are exactly
what vidcall's adapters + envelopes add.

### 3.3 OpenVidu — the product-features bar (SFU, Apache-2.0)
`Session`/`Publisher`/`Subscriber`/`StreamManager` + events; **token-based auth**; server-side
**composited recording**; broadcast to YouTube/Twitch; IP cameras; filters/**virtual background**;
**speech-to-text**; **network-quality events**; **automatic reconnection**; SIP/phone calls;
switch camera; data signals between users; Angular web components (`openvidu-components`).
Signaling is OpenVidu's own RPC over WS + REST; the server (Java) + Kurento media server are heavy.
Best reference for the *server-side* feature set `packages/server` is missing (tokens, webhooks/CDR,
composited recording, reconnect).

### 3.4 Galene — the minimal-SFU bar (MIT)
Single Go binary (server + web client), **symmetric JSON protocol over WS** (close in spirit to
vidcall's envelope: `type`/`kind`/`source`/`dest`/`value`, ping/pong, `join`/`joined`), groups with
permissions (`present`/`op`/`record`/`observe`/`message`/`admin`), password/token/crypto-token
auth, **camera & microphone selection**, per-user **video throughput** setting, blackboard mode,
**server-side recording**, **remote mute by moderator**, chat with history, STT add-on
(`galene-stt`), admin REST API. Validates vidcall's JSON-envelope-over-WS design (D3) and is the
reference for group auth/permissions and device selection in a tiny footprint.

### 3.5 mediasoup-demo — the SFU-control bar (ISC)
Node server + mediasoup workers + `mediasoup-client` (Device/Transport/Producer/Consumer). Shows the
full SFU control plane: **simulcast + SVC** (VP8/VP9 `L3T3_KEY`, AV1), **data-channel chat**,
force-codec options, E2EE key, face detection, live **stats panel**, network throttling,
pipe transports, consumer replicas. Signaling is *app-owned* (custom JSON over WS) — exactly the
shape vidcall's `SfuGateway` + `sfu` envelopes target. Reference for how much control surface an SFU
integration needs (producer/consumer/transport ids, scalability modes, layer preferences).

### 3.6 Janus videoroom — the gateway bar (GPL-3.0)
General-purpose C gateway with a plugin architecture; `videoroom` is an SFU with a
**publish/subscribe** model (publishers and subscribers on separate PeerConnections, multistream
optional), per-room config: max publishers, **bitrate caps**, `fir_freq`, codec allow-lists
(opus/g722/pcmu/pcma; vp8/vp9/h264/av1/h265), Opus FEC/DTX, audio-level events,
**server-side recording** (`.mjr` + post-processing), **mute**, **simulcast/SVC**, **E2EE**
(`require_e2ee`), data channels, admin API, RabbitMQ/MQTT event bus. Heavy C build; GPL-3.0 is a
license constraint vidcall must not copy. Reference for server-side recording + room policy knobs.

### 3.7 Jitsi Meet — the app-features bar (Apache-2.0)
Full conferencing app + embeddable iframe API + low-level `lib-jitsi-meet`
(`JitsiMeetJS.init` → `JitsiConnection` → `JitsiConference` → tracks/events). Features beyond the
others: **raise hand**, **reactions**, **polls**, **private chat**, **virtual backgrounds**,
E2EE, Jibri recording, Jigasi SIP, speaker stats, tile view. JVB (Kotlin) is a serious SFU over
COLIBRI/XMPP; the stack is heavy (Prosody XMPP + JVB + Jicofo + Jibri). Reference for the
*meeting-product* features vidcall's protocol lacks (raise-hand, polls) and for low-level SDK design
(`JitsiConference` mirrors vidcall's `Room`).

---

## 4. Where vidcall already leads

Before the gaps: vidcall is the only project in this set that is
- **backend-pluggable** — 6 signaling backends + InMemory + custom behind one `SignalingTransport`
  (CONTRIBUTING-mandated ≥2 implementations), whereas LiveKit/OpenVidu/Galene/Janus/Jitsi each lock
  you into their own signaling plane;
- **zero-runtime-dep in core** — platform `RTCPeerConnection` only; LiveKit/Jitsi/OpenVidu SDKs are
  large;
- **one versioned wire protocol across TS/Kotlin/Swift/Dart** — `protocol/schema.json` + L0
  conformance fixtures (`docs/testing.md`); no competitor shares one schema across 4 bindings;
- **pure adaptive-quality policy** — `packages/quality` consumes `RTCStatsSnapshot` with no WebRTC
  imports; no competitor exposes that as a library;
- shipping a **typed data-channel bus** (TS) and a **client-side recording facade + server storage**
  (Disk/S3 via a minimal SigV4 fetch client, no AWS SDK).

---

---

## 5. Gap list (grouped, severity, reference, concrete suggestion)

Legend: **must** = blocks parity with the user's stated goals (1:1 AND multi-user calling, all
client libs competitive); **should** = important for competitive parity; **could** = roadmap.

### 5.1 TS core (`packages/core`, `packages/quality`)

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| C1 | **Adaptive-quality policy never applied.** `AdaptiveQualityController` + `DeviceCapability` are pure and tested, but `Room`/`PeerConnectionManager` never feed `pc.getStats()` in and never apply decisions out (no `RTCRtpSender.setParameters`, `track.applyConstraints`, `degradationPreference`, simulcast `active` toggling). `packages/core` has **zero** references to `packages/quality`. | must | LiveKit adaptive stream + dynacast; Galene throughput caps; OpenVidu network quality | New `packages/core/src/quality-bridge.ts`: per-peer stats poller → `RTCStatsSnapshot` (fields per `packages/quality/src/stats.ts`) → `AdaptiveQualityController.tick()` → apply via `setParameters` (`maxBitrate`, `scaleResolutionDownBy`, per-encoding `active`), `applyConstraints`, transceiver `degradationPreference`; initial caps from `DeviceCapability.detect().initialTier()` at join; `RoomConfig.quality?: {enabled?, direction?, tiers?, maxTierId?}` in `room.ts`; tests reuse `packages/test-utils` fake RTC |
| C2 | **No device-management API.** No `enumerateDevices` / `selectDevice` / `switchCamera` / `restartTrack` / `facingMode`. | must | LiveKit `Room.getLocalDevices` / `switchActiveDevice` / `restartTrack`; Galene camera/mic menu | New `packages/core/src/devices.ts`: `listDevices(kind)`, `selectDevice(kind, deviceId)` (restart capture + renegotiate), `switchCamera()` (`facingMode`), apply presets; emit `device-changed`; document iOS Safari constraints |
| C3 | **No screen-share capture helper.** `announceScreenShare()` only broadcasts intent; no `getDisplayMedia()` wrapper, no `contentHint='detail'`, no auto-publish, no "already sharing" guard. | should | LiveKit `setScreenShareEnabled`; OpenVidu/Jitsi screen share | New `packages/core/src/screen-share.ts`: `startScreenShare(room, opts)` → `getDisplayMedia` → `publish(track, {source:'screen'})` → `announceScreenShare('start')`; `stopScreenShare()`; feature-detect iOS Safari → typed error |
| C4 | **No active-speaker detection.** No audio-level-based speaker events. | should | LiveKit `ActiveSpeakersChanged`; OpenVidu speech detection; Janus audiolevel events | New `packages/core/src/speaker-detection.ts`: poll `inbound-rtp.audioLevel` from `getStats()` (or WebAudio `AnalyserNode`), hysteresis, emit `active-speakers-changed: string[]`; set `RemoteParticipant.speaking` |
| C5 | **Mesh receive-side adaptation missing.** `TrackSubscription.setEnabled` exists but nothing automates pause-by-tile-visibility/size. | should | LiveKit adaptive stream | New `packages/core/src/auto-subscribe.ts`: app reports tile size/visibility (`updateTile(participantId, {visible, width, height})`) → `setEnabled`/resolution hint; wire to quality receive direction |
| C6 | **No E2EE.** No insertable-streams encryption anywhere. | could | LiveKit E2EE; Jitsi E2EE; mediasoup-demo `e2eKey` | New `packages/core/src/e2ee.ts`: `RTCRtpScriptTransform` worker (AES-GCM, key from `RoomConfig.e2eeKey`), feature-detect `RTCRtpScriptTransform`, apply per transceiver; fallback: no-op + warning |
| C7 | **Recording facade lacks pause/resume + mime/bitrate options** (composite hook exists). | could | OpenVidu/Janus server recording controls | Extend `packages/core/src/recording/media-recorder-recording-hook.ts`: `pause()/resume()`, `mimeType`/`videoBitsPerSecond` options, timeslice |
| C8 | **No engine-level reconnect policy.** `Room` doesn't re-join/re-publish on transport drop. | could | OpenVidu automatic reconnection; LiveKit reconnect | `RoomConfig.reconnect?: {maxAttempts, backoffMs}` in `room.ts`: on transport `onPresence`/emit failure → re-`join()` + re-publish tracks; events `reconnecting`/`reconnected` |

### 5.2 Protocol (`protocol/schema.json` + all bindings)

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| P1 | **Unicast targeting not in the schema.** TS mirror adds `targetSenderId` (additive); Kotlin uses a *transport-level* `targetSessionId` that is **not** in the envelope; Swift and Dart have **no targeting at all** — their `sendOffer/sendAnswer/sendIce` broadcast to the whole room. A >2-peer mesh across bindings is therefore inconsistent (JS/Kotlin filter, Swift/Dart don't). | must | mobile-bindings.md §2.2 (`to`); Galene `dest` | Add optional `targetSenderId` (string) to `schema.json` `properties` (additive, non-breaking); mirror in `protocol/types.ts`, `Envelope.kt`, `Envelope.swift`, `envelope.dart`; make Kotlin's `SignalingTransport.send` drop `targetSessionId` and use the envelope field; Swift/Dart gain `sendOffer(..., to:)` |
| P2 | **No `raise-hand` / `poll` message types.** Reactions exist; the rest of the Jitsi meeting surface doesn't. | should | Jitsi Meet raise hand + polls | Add `raise-hand` `{on: boolean, ts?}` and `poll` `{question, options[], vote?}` payloads to schema + `MESSAGE_TYPES` + all 4 mirrors + fixtures |
| P3 | **No `active-speaker` envelope.** Speaker detection (C4) would be local-only; backend users can't see speaking state. | should | LiveKit speaker events | Add `speaker` `{speaking: boolean, audioLevel?}` envelope (or fold into `presence` metadata) |
| P4 | **No `recording-state` / `device-change` envelopes.** webrtc-js.md §4.1 listed `recording-state`; schema dropped it; device switching (C2) isn't signaled. | should | webrtc-js.md §4.1; Janus recording events | Add `recording-state` `{on, recorderId?, sessionId?}` and `device-change` `{kind, deviceId?}` |
| P5 | **No server→client `quality-adapt` command.** mobile-bindings.md §2.2 defined `quality.adapt {action, layer?}`; schema only has `quality-warning` (peer→room). | could | mobile-bindings.md §2.2 | Add `quality-adapt` `{action: 'up'|'down'|'simulcast', layer?}` for SFU/server-driven adaptation |
| P6 | **`sfu` envelope too vague** for a real SFU (no transport/producer/consumer ids, no RTP params). | could | mediasoup-client control surface | Extend `SfuPayload` (`SfuTransport`/`SfuProducer`/`SfuConsumer` refs) when `packages/sfu-gateway/` lands (S7) |
| P7 | **No shared L0 fixtures directory.** Each binding has its own fixtures (Kotlin `SampleEnvelopes.kt`, Swift `Tests/VidcallTests/Fixtures/`, Dart `test/fixtures/`); mobile-bindings.md §2.2 promised shared `protocol/fixtures/*.json`. | should | mobile-bindings.md §2.2; docs/testing.md L0 | Add `protocol/fixtures/*.json` (one per type + scenarios) consumed by all four conformance suites |

### 5.3 Kotlin binding (`packages/kotlin`)

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| K1 | **No data-channel support.** `PeerConnectionManager.observer().onDataChannel = Unit // DataChannelBus: future work`; reactions/chat only via backend pub/sub. | must | JS `DataChannelBus`; LiveKit data messages | New `packages/kotlin/vidcall-android/src/main/kotlin/io/vidcall/android/DataChannelBus.kt` mirroring the JS wire `{v,t,d}` (reaction/chat/control); create channel in `addPeer`, wire `onDataChannel` + `onRenegotiationNeeded` |
| K2 | **Dedupe/reorder incomplete.** `VidcallClient.seen` keys on `(senderId, seq)` — no `sessionId`, so a rejoined session (same senderId, seq restarting at 0) gets **dropped as duplicate**; and no reorder buffer for unordered backends (JS has `OrderedMessageBuffer`). | should | JS `OrderedMessageBuffer` (`packages/core/src/ordering.ts`) | Key `seen` on `(sessionId, seq)` (fallback senderId) and add a small reorder buffer for `offer/answer` kinds in `VidcallClient.dispatch` |
| K3 | **No ICE restart.** JS manager has `restartIce()` + auto-restart on `failed`; Kotlin manager lacks both. | should | JS `PeerConnectionManager.restartIce` | Add `fun restartIce(peerId)` (`pc.restartIce()` + renegotiate) + auto-restart on `onIceConnectionChange(FAILED)` in `PeerConnectionManager.kt` |
| K4 | **No adaptive quality / stats.** No `getStats()` polling or `setParameters`; org.webrtc `RtpParameters` supports it. | should | C1; LiveKit Kotlin SDK | New `VidcallRtcQualityController` mirroring `packages/quality` thresholds (port the pure logic to Kotlin; share fixtures for parity) |
| K5 | **No local mute / device-switch helpers.** `createLocalMedia` exists but no `setMicrophoneEnabled` / `switchCamera`; org.webrtc `AudioTrack.setEnabled` / `CameraVideoCapturer.switchCamera` are trivial. | should | LiveKit `setMicrophoneEnabled`; Galene device menu | Add `fun setLocalAudioEnabled(Boolean)` / `setLocalVideoEnabled(Boolean)` / `fun switchCamera()` on `VidcallRtcClient` |
| K6 | **No recording hook** (Android `MediaRecorder` is available). | could | JS recording facade | `VidcallRtcClient.recording` facade mirroring `packages/core/src/recording/` (composite of local+remote surfaces) |
| K7 | **No roster ack on join.** Newcomer learns existing peers only when an offer arrives (works, but the presence roster lags). | could | JS `Room.handleRemoteJoin` targeted join reply | Reply to a `join` envelope with a targeted `join` (like JS core) in `VidcallRtcClient` |

### 5.4 Swift binding (`packages/swift`)

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| S1 | **WebRTC layer is a stub.** `VidcallWebRTC` compiles only under `#if canImport(WebRTC)`; the SwiftPM binary target + checksum are commented out in `Package.swift`; no CI exercises real media. | must | LiveKit/Jitsi iOS SDKs ship real WebRTC | Enable the `.binaryTarget` (WebRTC 150.0.0 xcframework, checksum already recorded) by default; add an L2 test (two `VidcallWebRTC` peers over a local relay) |
| S2 | **No unicast targeting.** `sendOffer/sendAnswer/sendIce` always broadcast (see P1). | must | P1; Galene `dest` | Add `targetSenderId` to `Envelope.swift` + `send(_:to:)` overloads |
| S3 | **No dedupe/reorder/idempotency.** `VidcallClient` delivers every envelope; duplicates from unordered backends are not filtered. | should | JS `OrderedMessageBuffer` | Port `OrderedMessageBuffer` (keyed by `sessionId`) into `VidcallClient.handleIncoming` |
| S4 | **No presence tracking/sweeper.** Heartbeat (ping/pong) exists, but presence envelopes are relayed raw; no join/leave/expiry state machine. | should | Supabase/Convex presence adapters; JS `handlePresence` | Add `ParticipantPresenceTracker` (joinedAt/lastSeen, stale→offline sweep) to `VidcallClient` |
| S5 | **No backend adapters.** WebSocket-only; mobile-bindings.md §3 lists official Supabase/Convex/Firebase/Appwrite SDKs for iOS but none are wired. | could | mobile-bindings.md §3; JS `backend-*` | Add `VidcallSupabaseTransport`/`VidcallConvexTransport` (or document the relay pattern + conformance tests) |
| S6 | **macOS target declared but untested** (`platforms: [.iOS(.v13), .macOS(.v10_15)]`); WebRTC pod is iOS-only. | could | mobile-bindings.md §1.3 | Document macOS via `flutter_webrtc`/`dart_webrtc`; drop or annotate the macOS platform claim |

### 5.5 Dart binding (`packages/dart`)

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| D1 | **Single-peer RTC session — no mesh.** `VidcallRtcSession` wraps ONE `RTCPeerConnection`; group calls (the user's stated multi-user requirement) are impossible. | must | JS `Room`; Kotlin `VidcallRtcClient`; LiveKit Room | New `packages/dart/lib/src/webrtc/rtc_mesh.dart`: `VidcallRtcMesh` — `Map<String, VidcallRtcSession>`, join-driven peer creation, per-peer polite polarity, teardown on `leave`, screen-share track to all peers |
| D2 | **No dedupe/reorder.** Dart client emits every envelope (see S3). | should | JS `OrderedMessageBuffer` | Port `OrderedMessageBuffer` into `VidcallClient._listen` (key by `sessionId`) |
| D3 | **No auto ICE restart.** `restartIce()` is manual; no restart on `failed`. | should | JS `PeerConnectionManager` auto-restart | In `rtc_session.dart`, on `onIceConnectionState == failed` → `restartIce()` (with backoff guard) |
| D4 | **No stats/quality.** No `getStats()` exposure or quality controller. | should | C1 | Add `Stream<RTCStatsSnapshot>`-style stats export + optional quality controller mirroring `packages/quality` |
| D5 | **Both-peers-polite default.** `polite = true` default can livelock glare between two polite peers (each rolls back). | should | JS core `selfId < remoteId` rule | Default `polite` to `(myId, remoteId) => myId < remoteId` in `VidcallRtcSession` |
| D6 | **No presence sweeper / recording / device mgmt** (same as Swift S4/S5, C2, C7). | could | — | Track with S4/C2/C7; add `dart` implementations when the TS APIs land |

### 5.6 Server / backend (`packages/server`, `packages/backend-*`)

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| B1 | **No auth/tokens.** `packages/server/src/core.ts` has zero auth references: any client can `joinRoom` any room; no participant identity verification. | must | LiveKit JWT; OpenVidu tokens; Galene passwords/tokens | New `packages/server/src/auth.ts`: `createRoomToken(roomId, participantId, {secret, ttl, claims})` (HMAC), `verifyRoomToken`; enforce in `joinRoom` via `JoinRoomOptions.token`; wire into `http.ts`/`ws.ts` handlers; document |
| B2 | **No webhooks/CDR events.** Join/leave/recording events are not pushed anywhere. | should | LiveKit webhooks; OpenVidu Webhook/CDR | New `packages/server/src/webhooks.ts`: outbound signed POST (`X-Vidcall-Signature`) on `join`/`leave`/`recording.finalized`; config via `WebhookOptions` |
| B3 | **No server-side (SFU) recording.** Recording = client MediaRecorder → storage; no composited server recording. | should | OpenVidu recording; Janus videoroom; Jibri | Blocked on S7 (SFU). When `packages/sfu-gateway/` lands, add an egress recorder that consumes `sfu` layer streams and writes to the existing `RecordingStorage` |
| B4 | **Room policy is thin.** Only `maxParticipants`; no locked rooms, recording permissions, or per-room codec policy. | should | Galene group config; Janus videoroom config | Extend `Room.metadata` policy (`locked`, `allowRecording`, `allowedCodecs`) enforced in `core.ts` (`joinRoom`/`startRecording`) |
| B5 | **No SFU integration (SfuGateway unimplemented).** architecture.md §4 lists `packages/sfu-gateway/`; it doesn't exist. `sfu` envelopes are parsed and ignored (`Room.handleEnvelope` → `case 'sfu': break`). | should | LiveKit server; mediasoup; Janus videoroom | Scaffold `packages/sfu-gateway/`: `SfuGateway` interface (publish/subscribe/layer-change/keyframe), reference mediasoup adapter, keep `sfu` envelopes flowing through the same transport; document LiveKit path |
| B6 | **No TURN provisioning.** No ephemeral-credential endpoint or guide. | could | Janus TURN REST API; LiveKit turn | New `packages/server/src/turn.ts` — coturn REST credentials endpoint (or docs guide in `integrations/`) |
| B7 | **No SIP/PSTN, no transcription.** | could | Jigasi (Jitsi); OpenVidu phone calls; galene-stt | Document as future integrations; optionally add webhook hooks (B2) for STT services |

### 5.7 Docs & examples

| # | Gap | Sev | Reference | Concrete suggestion (file-level) |
|---|---|---|---|---|
| E1 | **No runnable examples.** `examples/` (vite-react, node, zoom-clone) is in architecture.md §4 but absent; every competitor ships a demo. | should | mediasoup-demo; LiveKit Meet; OpenVidu tutorials; Galene web client | New `examples/vite-react/` (video grid + reactions + chat + screen share + device menu), `examples/node/` (two werift peers over `backend-sqlite`/InMemory), `examples/zoom-clone/`; add to CI build step |
| E2 | **No API reference docs.** `docs/api/` (architecture.md §4) absent; CONTRIBUTING.md requires every public API item documented. | should | LiveKit SDK reference; OpenVidu API docs | TypeDoc for `packages/core|quality|transport|server`; dokka (Kotlin), docc (Swift), dartdoc (Dart); wire into CI |
| E3 | **Missing per-package READMEs.** `core`, `quality`, `backend-appwrite`, `backend-sqlite`, `swift`, `test-utils` have no README (CONTRIBUTING.md requires README per package + dependency rationale). | should | CONTRIBUTING.md | Add README.md to each listed package with API sketch, usage, dependency table (name, pin, publish date, why) |
| E4 | **No SFU/TURN/zoom-clone guides.** architecture.md promises mediasoup/LiveKit integration guides. | could | mediasoup docs; LiveKit docs | New `docs/guides/sfu-mediasoup.md`, `docs/guides/sfu-livekit.md`, `docs/guides/turn.md`, `docs/guides/zoom-clone.md` |
| E5 | **iOS Safari capability caveats not surfaced in docs/engine** (no `getDisplayMedia`, no send-side simulcast, no VP9/AV1). | should | webrtc-js.md §7 | `docs/guides/platform-support.md` + runtime warnings from `DeviceCapability`/`capabilities` in `join` |

---

---

## 6. Leftover tasks (ticket-ready)

Ordered by dependency (each row is one ticket; IDs reference §5 gaps).

| Ticket | Title | Sev | Depends on | Acceptance criteria |
|---|---|---|---|---|
| VC-1 | Wire adaptive-quality policy into the engine | must | — | `quality-bridge.ts` applies decisions to a fake sender; unit tests green; `quality:changed` fires from real `getStats()` |
| VC-2 | Device-management API (TS) | must | — | `listDevices/selectDevice/switchCamera` + `device-changed` event; tests with fake devices |
| VC-3 | Unicast targeting in schema + all bindings | must | — | `targetSenderId` in schema; TS/Kotlin/Swift/Dart send targeted offer/answer/ice; L0 fixtures updated |
| VC-4 | Swift: enable WebRTC binary target + L2 test | must | — | `swift build` with WebRTC linked; 2-peer loopback test green |
| VC-5 | Dart: multi-peer mesh (`VidcallRtcMesh`) | must | — | 3-peer mesh over local relay; leave teardown; tests green |
| VC-6 | Server: room tokens/auth | must | — | `createRoomToken/verifyRoomToken`; WS join rejects bad token; tests |
| VC-7 | Kotlin: DataChannelBus | must | — | reaction/chat over SCTP between two Android peers (or JVM fakes) |
| VC-8 | Screen-share helper (TS) + Kotlin/Swift/Dart equivalents | should | VC-2 | `startScreenShare/stopScreenShare`; Safari error path |
| VC-9 | Active-speaker detection + `speaker` envelope | should | — | `active-speakers-changed` events; L0 fixture |
| VC-10 | SFU gateway scaffold + mediasoup reference adapter | should | — | `packages/sfu-gateway/` interface + adapter; `sfu` envelopes exercised in a test room |
| VC-11 | Server webhooks/CDR | should | VC-6 | signed POST on join/leave/recording; test server |
| VC-12 | Kotlin ICE restart + mute/device helpers | should | — | `restartIce()` auto on failed; `setLocalAudioEnabled/switchCamera` |
| VC-13 | Swift/Dart dedupe+reorder port | should | — | duplicate/out-of-order envelopes dropped; tests |
| VC-14 | Room policy: locked/allowRecording/codecs | should | VC-6 | `joinRoom` enforces policy; store tests |
| VC-15 | Shared L0 fixtures + conformance in 4 langs | should | VC-3 | `protocol/fixtures/*.json`; all four suites consume them |
| VC-16 | Examples: vite-react, node, zoom-clone | should | VC-1, VC-2 | runnable; CI builds them |
| VC-17 | Per-package READMEs + API reference docs | should | — | missing READMEs added; TypeDoc/dokka/docc/dartdoc in CI |
| VC-18 | E2EE (insertable streams, TS first) | could | — | AES-GCM keyed transform; feature-detected fallback |
| VC-19 | Engine reconnect policy | could | — | re-join + re-publish; `reconnecting/reconnected` events |
| VC-20 | TURN credentials endpoint + guides | could | VC-6 | coturn REST integration or documented coTURN setup |
| VC-21 | Raise-hand + polls in protocol + bindings | could | VC-3 | new payload types + L0 fixtures |
| VC-22 | SFU egress recording to existing storage | could | VC-10 | server recorder consumes SFU streams → `RecordingStorage` |

**Suggested sequencing:** VC-3 first (schema is the contract), then VC-1/VC-2 (TS core parity),
VC-6 (server), VC-4/VC-5/VC-7 (binding parity), then the `should` row.

---

## 7. Sources (all accessed 2026-08-12)

**vidcall (read-only):** `docs/architecture.md` · `docs/research/webrtc-js.md` ·
`docs/research/mobile-bindings.md` · `docs/research/backend-adapters.md` · `docs/testing.md` ·
`protocol/schema.json` · `protocol/types.ts` · `packages/core/src/{room,peer-connection-manager,
data-channel-bus,ordering,participants}.ts` · `packages/quality/src/*` ·
`packages/transport/src/{types,base}.ts` · `packages/server/src/{core,types,recording}.ts` ·
`packages/{kotlin,swift,dart}` sources (see §5 for file-level cites).

**Competitors:**
- LiveKit: <https://github.com/livekit/livekit> · <https://github.com/livekit/client-sdk-js>
- PeerJS: <https://github.com/peers/peerjs> · <https://github.com/peers/peerjs-server>
- OpenVidu: <https://github.com/OpenVidu/openvidu> · <https://docs.openvidu.io/en/stable/>
- Galene: <https://github.com/jech/galene> · <https://galene.org/> ·
  <https://raw.githubusercontent.com/jech/galene/master/galene-protocol.md> ·
  <https://raw.githubusercontent.com/jech/galene/master/galene.md>
- mediasoup-demo: <https://github.com/versatica/mediasoup-demo> · <https://mediasoup.org/>
- Janus: <https://github.com/meetecho/janus-gateway> · <https://janus.conf.meetecho.com/docs/videoroom.html>
- Jitsi: <https://github.com/jitsi/jitsi-meet> · <https://github.com/jitsi/lib-jitsi-meet> ·
  <https://github.com/jitsi/jitsi-videobridge> · <https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-ljm-api/>

---
