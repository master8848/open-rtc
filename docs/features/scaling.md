# Scaling — mesh → SFU, simulcast/SVC, signaling, recording

> Status: implementation doc. Builds on `docs/features/call-models.md` (topology
> and bandwidth math) and `packages/sfu-gateway` (the SFU contract).

vidcall scales in four independent planes:

1. **Media plane**: mesh → SFU gateway (`SfuGateway` + `SfuSession`).
2. **Codec plane**: simulcast/SVC so the SFU forwards one layer per subscriber.
3. **Signaling plane**: pub/sub fan-out, chunking, heartbeat, rate discipline.
4. **Recording plane**: client-side `MediaRecorder` hooks vs server-side egress.

---

## 1. Mesh → SFU: when and how

### 1.1 When to migrate

`docs/features/call-models.md` §3.2 shows the mesh breaking down at 4–6 video
participants (uplink bandwidth, decode count, encode count, renegotiation
storms). Operational signals that it is time:

- `AdaptiveQualityController` reports sustained `network` downgrades on
  typical participants (bitrate tiers pinned at 360p15 / audio-only).
- `qualityLimitationReason: 'cpu'` on senders (encoders saturated).
- Packet loss / RTT rising as N grows (uplink saturation).
- Recording or compliance needs that want server-side capture (see §5).

### 1.2 What changes

|                  | Mesh          | SFU                                         |
| ---------------- | ------------- | ------------------------------------------- |
| Peer connections | N−1 per peer  | 1 per peer (to the gateway)                 |
| Uplinks          | N−1           | **1**                                       |
| Downlinks        | N−1           | N−1 (server forwards per-subscriber layers) |
| Encode           | N−1 per track | 1 (simulcast/SVC layers)                    |
| Decode           | N−1           | N−1 (but at chosen layers)                  |
| Media server     | none          | yes (mediasoup/LiveKit/Janus/…)             |
| Signaling        | unchanged     | **unchanged** (same envelope, `sfu` type)   |

The client API (`Room`, `publish`, `track` events, `room.controls`) is the
same; only the media-plane implementation behind it changes.

### 1.3 How to migrate

1. Deploy an SFU (see §2).
2. Implement an `SfuGateway` adapter (or use the reference
   `MediasoupAdapter`) mapping `join/publishTrack/subscribe/
setPreferredLayers/requestKeyframe` onto the server.
3. Route the wire `sfu` envelopes through `SfuRouter` (validates room
   membership, requires a joined session, forwards to the session).
4. In the client, replace per-peer `RTCPeerConnection` management with one
   gateway session per participant; keep `room.publish` semantics by mapping
   them to `session.publishTrack` + SDP passthrough (`handleOffer`).
5. Flip a feature flag per room: small rooms stay mesh, large rooms go SFU.

---

## 2. Media server options

### 2.1 Comparison

|                       | **mediasoup**                                                                                  | **LiveKit**                                                                                                               | **Janus**                                                     | **Jitsi Videobridge**              |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| Language              | Node.js (C++ workers)                                                                          | Go                                                                                                                        | C (plugins)                                                   | Java/Kotlin                        |
| License               | ISC                                                                                            | Apache-2.0                                                                                                                | **GPLv3**                                                     | Apache-2.0                         |
| Shape                 | **Library** — you build signaling + app                                                        | **Platform** — server + client SDK + protocol                                                                             | Gateway with plugins (`videoroom`, recorder)                  | SFU with COLIBRI protocol          |
| Signaling             | None (you build it)                                                                            | LiveKit's own WebSocket protocol                                                                                          | Janus plugin protocol                                         | COLIBRI                            |
| Simulcast/SVC         | First-class                                                                                    | First-class + **adaptive stream** (SDK auto-selects layer by tile size/visibility)                                        | Supported in videoroom                                        | Supported                          |
| Recording/egress      | Via app (server side)                                                                          | **Egress** built in                                                                                                       | Recorder plugin                                               | In Jitsi Meet stack                |
| vidcall fit           | Reference adapter ships in `@vidcall/sfu-gateway`; you own signaling (matches vidcall's model) | Use `livekit-client` directly or a thin adapter — but LiveKit owns the peer connection, so pluggable backends don't apply | GPLv3 forces license review; plugin protocol needs an adapter | Apache-2.0; COLIBRI adapter needed |
| Publish date / status | 2016-01-01, very active                                                                        | 2021-01-24, very active                                                                                                   | 2014, active                                                  | 2014, active                       |

(All verified ≥14-day supply-chain age; details in `docs/research/webrtc-js.md` §3.2.)

### 2.2 Recommendations

- **Self-hosted, vidcall-native:** **mediasoup** — it is a library, not a
  product, so the app keeps owning signaling (which vidcall already provides
  via pluggable backends). The reference `MediasoupAdapter` maps
  `SfuGateway` → mediasoup 1:1 (see §2.3).
- **Managed, feature-rich:** **LiveKit** — best egress/adaptive-stream
  story; use `livekit-client` directly for the media plane or wrap it in an
  `SfuGateway` adapter. Note LiveKit's protocol owns the peer connection, so
  it replaces (not plugs into) vidcall's engine.
- **Existing infra / multipurpose:** **Janus** — powerful but GPLv3
  (review licensing) and its plugin protocol needs a custom adapter.
- **Jitsi stack already in use:** Jitsi Videobridge via a COLIBRI adapter.

### 2.3 `SfuGateway` → mediasoup mapping (reference adapter)

| `SfuGateway` / `SfuSession`          | mediasoup                                      |
| ------------------------------------ | ---------------------------------------------- |
| `join(roomId, participantId)`        | `router.createWebRtcTransport()`               |
| `publishTrack(trackId, kind)`        | `transport.produce()` (after the client offer) |
| `subscribe(participantId)`           | `transport.consume()`                          |
| `setPreferredLayers(trackId, layer)` | `consumer.setPreferredLayers()`                |
| `requestKeyframe(trackId)`           | `producer.requestKeyFrame()`                   |
| `handleOffer` / `handleAnswer`       | `transport.connect({ dtlsParameters })`        |
| `addIceCandidate`                    | `transport.addIceCandidate()`                  |
| `leave()`                            | `transport.close()`                            |

The adapter is deliberately SDP-minimal (see `packages/sfu-gateway/src/sdp.ts`);
production deployments may swap in a full SDP translation layer.

---

## 3. Simulcast and SVC

An SFU forwards **one layer per subscriber**, so the sender encodes layers
once and the server trims per-subscriber. Two encodings achieve this:

|                 | Simulcast (RFC 8853)                               | SVC (VP9/AV1 `scalabilityMode`)                           |
| --------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Wire            | 2–3 independent streams (`rid: f/h/q`)             | one stream, spatial+temporal layers                       |
| Layer down      | SFU drops packets                                  | SFU drops packets (cheap)                                 |
| Layer up        | needs keyframe on the new layer                    | needs keyframe (spatial)                                  |
| Browser support | Chrome/Edge/Firefox send; **Safari: no send-side** | Chrome VP9/AV1; Firefox VP9 temporal only; **Safari: no** |

### 3.1 Send-side setup

The engine requests layers when publishing (adapter maps to
`RTCRtpSender.setParameters` encodings):

```ts
await session.publishTrack('cam-1', 'video', {
  simulcast: true, // e.g. 1080p/720p/360p with rids f/h/q
});
```

For single-stream (Safari) senders, the client falls back to bitrate caps via
`AdaptiveQualityController` (maxBitrate / scaleResolutionDownBy /
degradationPreference). Capability hints (`capabilities.simulcast/svc/codecs`)
travel in the `join` envelope so the SFU knows what to expect.

### 3.2 Receive-side layer selection

```ts
// wire: sfu{action:'layer-change', trackId, layer:'m'}
await session.setPreferredLayers('cam-1', 'm'); // 'l' | 'm' | 'h'
```

Best practice: choose the layer from the rendered tile size + network state
(LiveKit calls this "adaptive stream"; vidcall leaves the policy to the app
or `AdaptiveQualityController`'s receive-side path). In mesh there are no
layers to pick — the receive-side analog is `TrackSubscription.setEnabled()`
(pause decoding of hidden tiles).

### 3.3 Keyframes at scale

- **Layer-up requires a keyframe.** Use `session.requestKeyframe(trackId)`
  (wire `sfu{action:'keyframe-request'}`; mediasoup
  `producer.requestKeyFrame()`, Chromium `RTCRtpScriptTransformer.
generateKeyFrame()`).
- **Join storms:** many viewers joining at once each requesting keyframes
  spikes encoder+network. Stagger requests (jitter 0–1 s) and prefer SFUs
  with keyframe caching (LiveKit fast-starts subscribers).
- **PLI/FIR** (RFC 4585/5104) are handled automatically by browsers on loss;
  don't build custom loss recovery.

---

## 4. Signaling scaling (pub/sub fan-out)

Signaling is JSON envelopes over the backend's own pub/sub — one channel per
room. The scaling levers:

### 4.1 Envelope size and rate

| Envelope                                  | Size       | Rate                                                      |
| ----------------------------------------- | ---------- | --------------------------------------------------------- |
| `offer`/`answer` (full SDP, unified-plan) | 3–10 KB    | per renegotiation (rare; `replaceTrack` avoids most)      |
| `ice` candidate                           | ~100–300 B | burst of 2–10 per peer per connection                     |
| `join`/`leave`/`presence`                 | ~200 B     | join/leave + heartbeat (30 s)                             |
| `reaction`/`chat`                         | < 1 KB     | throttled (~≥250 ms between reactions; chat ≤ 4000 chars) |
| `sfu` control                             | < 500 B    | per publish/subscribe/layer-change                        |

A 100-person room therefore moves well under 1 MB/min of signaling — the
bottleneck is _message rate limits_ on managed backends, not bytes.

### 4.2 Backend fan-out characteristics

| Backend           | Fan-out primitive                            | Scale notes                                                                                                  |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Supabase Realtime | one broadcast channel per room (`room:{id}`) | ordered per channel; watch per-channel message limits                                                        |
| Convex            | mutation writes + subscription query         | eventually consistent; engine's `OrderedMessageBuffer` absorbs reordering                                    |
| Firebase RTDB     | push at `rooms/{id}/msgs` + `child_added`    | ordered by key; `onDisconnect` presence                                                                      |
| Appwrite          | realtime events on collection docs           | one-way → doc-write signaling + heartbeat presence                                                           |
| Postgres          | `LISTEN/NOTIFY`                              | **7 KB NOTIFY payload cap** — the transport chunker splits larger envelopes; browser clients need a WS relay |
| SQLite/libSQL     | BroadcastChannel                             | same-device only (dev/test)                                                                                  |

All of them: the engine owns ordering/idempotency/glare, so adapters can be
dumb and stay within each platform's limits.

### 4.3 Rate discipline

- **ICE coalescing** in the transport package merges candidate bursts per
  peer per tick.
- **Chunker** splits envelopes > backend limits (Postgres 7 KB NOTIFY) and
  reassembles on the receiver.
- **Heartbeat + presence expiry** (backend-native `onDisconnect` where
  available) removes dead peers without explicit `leave`.
- **Peer-addressed envelopes** (`targetSenderId`) keep SDP/ICE fan-out O(1)
  instead of O(N) per peer.
- For very large rooms, disable per-peer ICE in signaling and let the SFU
  own media-plane signaling (only `sfu` envelopes + presence remain).

---

## 5. Recording at scale

### 5.1 Client-side recording (vidcall default)

`RoomRecordingFacade` (`room.recording`) composites the local stream + remote
streams into a `MediaRecorder` and uploads chunks via the recording endpoint
(`room.recording.startRecording({ localStream, remoteStreams })` →
`recording:blob-chunk` → `FetchRecordingUploader` → finalize report). Wire:
`recording-state` envelopes announce recorders to peers.

**Costs that grow with N:**

| Cost           | Behavior                                                           |
| -------------- | ------------------------------------------------------------------ |
| CPU            | each recording client encodes a composite — significant on mobile  |
| Sync           | remote streams arrive over the network; composite timestamps drift |
| Storage/egress | each client uploads its own composite; server must dedupe          |
| Failure modes  | recorder dies with the tab; tab backgrounding kills MediaRecorder  |

**Best for:** 1:1–small group calls, MVP recording, user-initiated
"record this call on my device".

### 5.2 Server-side egress (at scale)

The SFU receives every stream once — recording there is O(N) media + O(1)
per room:

| Option                    | Notes                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **LiveKit Egress**        | built-in: room/composite/track egress to S3; the strongest managed option                       |
| **Janus recorder plugin** | per-participant WebM recordings; plugin-based                                                   |
| **mediasoup + app**       | you run the recorder (e.g. FFmpeg/mediabunny) server-side against `producer`/`consumer` streams |
| **vidcall RecordingHook** | the hook interface stays; SFU mode may delegate to egress instead of MediaRecorder              |

**Why server-side wins at scale:** one copy of each stream, no client CPU,
no client upload bandwidth, gapless even when participants drop, and
compliance-grade capture (retention, redaction, audit) can be applied on the
server.

### 5.3 Decision guide

| Scenario                      | Recording                                         |
| ----------------------------- | ------------------------------------------------- |
| 1:1 MVP, user-initiated       | client-side `room.recording` (MediaRecorder)      |
| 2–4 mesh, "record this call"  | client-side composite; cap at 1 recorder          |
| Classroom/webinar 10–100      | **SFU egress** (LiveKit Egress or Janus recorder) |
| Compliance/archive            | **SFU egress** + server-side retention            |
| Mobile participants recording | never client-side (CPU + backgrounding)           |

---

## 6. Reference architecture at scale

```
Clients (vidcall app)
   │  signaling: backend pub/sub (Supabase/Convex/… )   [unchanged at scale]
   │  media:     1 RTCPeerConnection each → SFU
   ▼
SFU (mediasoup via MediasoupAdapter | LiveKit | Janus)
   │  simulcast/SVC layer forwarding (setPreferredLayers)
   │  keyframe-request handling (requestKeyframe)
   ├──► Egress/recorder (LiveKit Egress | Janus recorder | app-side)
   ▼
TURN (coTURN) for NAT-traversal failures          ──  STUN is not enough (§7.1 research)
   ▲
   └── signaling relay for Postgres/SQLite backends (WS bridge)
```

**Related:** `docs/features/call-models.md` (topologies + bandwidth math) ·
`docs/features/controls.md` (local controls work identically in SFU mode).
