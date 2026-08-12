# Call models — 1:1, mesh, and SFU

> Status: implementation doc (matches `packages/core`, `packages/sfu-gateway`, `protocol/schema.json`).
> Background: `docs/research/webrtc-js.md` §3 (mesh vs SFU), `docs/architecture.md` D2/D3.

vidcall is **mesh-first**: the shipped core connects every participant to every
other participant with a direct `RTCPeerConnection`, over any dumb pub/sub
signaling backend. An optional `SfuGateway` interface (plus a reference
mediasoup adapter in `@vidcall/sfu-gateway`) is the migration path when a call
outgrows a mesh. This document explains the three call models, the bandwidth
math that decides between them, and how vidcall's signaling + wire protocol
support each one.

---

## 1. Model overview

| Model                               | Media path                                                       | vidcall surface                                      | Best for                                                                     |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| **1:1 (duo)**                       | One `RTCPeerConnection` per peer                                 | `Room` (mesh engine, two participants)               | Sales/support calls, tutoring, interviews, any two-person conversation       |
| **N-way mesh**                      | `N−1` `RTCPeerConnection`s per peer (one per remote)             | `Room` (default, no extra infra)                     | 2–4 video participants, larger audio-only rooms, events over "dumb" backends |
| **SFU (selective forwarding unit)** | One uplink to a media server; the server forwards to subscribers | `SfuGateway` + `SfuSession` (`@vidcall/sfu-gateway`) | 5+ video participants, webinars, large classes, recording/egress needs       |

The wire protocol is identical in all three modes: the same JSON envelope
(`protocol/schema.json`) carries `join`/`offer`/`answer`/`ice` for mesh, and
`sfu` envelopes (`publish`/`subscribe`/`layer-change`/`keyframe-request`/
`leave`) plus `offer`/`answer`/`ice` addressed to the SFU for gateway mode.
Switching models does not change the signaling layer — it changes _who_ the
peer connections point at.

---

## 2. 1:1 calls

A 1:1 call is the degenerate mesh: exactly two `RTCPeerConnection`s (one on
each side), one m-line per published track.

```
Alice ── RTCPeerConnection (audio + video + data channel) ── Bob
   │                                                          │
   └────────── signaling: backend pub/sub (any adapter) ──────┘
```

### 2.1 Connection setup (wire flow)

```
A: join(room)                 ──►  room channel (presence: A online)
B: join(room)                 ──►  presence: [A, B]
A: publish(mic+cam)           ──►  negotiationneeded
A: offer{sdp}                 ──►  B: setRemoteDescription → ontrack
B: answer{sdp}                ──►  A: setRemoteDescription → ICE connects
A/B: ice{candidate}           ──►  trickle both ways (RFC 8838)
…DTLS/SRTP handshake happens in the browser…
connectionState → 'connected'
A: reaction 👍 / chat / screen-share  ──►  room broadcast + data channel
```

Everything is handled by `PeerConnectionManager` (perfect negotiation,
trickle-ICE buffering, SDP idempotency, ICE restart). The app only calls
`room.join()` and `room.publish(track)`:

```ts
const room = new Room({ roomId, selfId, transport: supabaseTransport });
room.on('track', ({ participant, track }) => attachToVideo(participant, track));
await room.join();
await room.publish(
  await getUserMedia({ audio: true, video: true }).then((s) => s.getVideoTracks()[0]),
  { source: 'camera' },
);
```

### 2.2 Why 1:1 always works

- One uplink, one downlink: **~1.5 Mbps up and ~1.5 Mbps down** for a 720p30
  call — comfortably inside home/mobile connections.
- One encode, one decode: no CPU wall on any device.
- No media server, no TURN relay traffic (TURN is still needed for NAT
  traversal, but only relays when direct ICE fails).
- Signaling is one room channel on any of the pluggable backends (Supabase,
  Convex, Firebase, Appwrite, Postgres, SQLite, custom).

---

## 3. N-way mesh

### 3.1 Topology and costs

Each participant holds an `RTCPeerConnection` to every other participant:

```
        ┌─────┐
        │  A  │──pc──┐
        └──┬──┘      │
   pc       │        ▼
   │    ┌───┴───┐  ┌─┴──┐
   ▼    │   B   │  │ C  │
  ┌─┴──┐ └───┬──┘  └────┘
  │ D  │─────┘
  └────┘
```

Per peer (N participants):

| Resource             | Cost per peer                   | N=4 example                 |
| -------------------- | ------------------------------- | --------------------------- |
| Uplinks              | **N−1** (one per remote peer)   | 3                           |
| Downlinks            | N−1                             | 3                           |
| Video encodes        | N−1 (one per remote connection) | 3                           |
| Video decodes        | N−1                             | 3                           |
| Uplink bandwidth     | (N−1) × local video bitrate     | 3 × 1.5 Mbps ≈ **4.5 Mbps** |
| Downlink bandwidth   | Σ remote video bitrates         | 3 × 1.5 Mbps ≈ 4.5 Mbps     |
| `RTCPeerConnection`s | N−1                             | 3                           |

(Simulcast doesn't help mesh — the sender adapts for the worst receiver, and
each remote gets its own encoding. SVC layer drops also require an SFU to be
useful. See `docs/features/scaling.md` §3.)

### 3.2 When the mesh breaks down

The mesh fails at roughly **4–6 video participants**, and the reasons stack:

1. **Uplink bandwidth.** At 1.5 Mbps per remote, a 6-person call needs
   ~7.5 Mbps upload. Typical home upload is 5–20 Mbps; mobile upload is often
   below 5 Mbps. `AdaptiveQualityController` (packages/quality) will keep
   downgrading tiers, and below ~150 kbps the policy falls to audio-only.
2. **Downlink + decode.** Each peer decodes N−1 streams. Decoding 5×720p30 in
   software is beyond many laptops and most phones; iOS Safari in particular
   cannot reliably render more than ~2–4 simultaneous video elements
   (WebKit bug 179363, see research doc §7.2).
3. **Encode load.** N−1 encoders per peer (one per connection) burn CPU/GPU;
   the encoder reports `qualityLimitationReason: 'cpu'`, which the policy
   engine reacts to by dropping tiers.
4. **Renegotiation storms.** Every track add/remove (screen share, camera
   toggle) renegotiates with every peer. With N peers that is N−1 SDP
   exchanges per change (mitigated by `replaceTrack` in `ControlsManager` —
   see `docs/features/controls.md` §4).

**Rule of thumb:** mesh for **2–4 video** participants; more for
**audio-only** rooms (Opus is ~50 kbps per participant); SFU beyond that.

### 3.3 Mesh is the zero-ops default

The mesh needs no media server, no per-minute infra cost, and works over _any_
pub/sub backend — which is exactly why it is vidcall's core (architecture D2).
Presence, reactions, chat, and screen-share announcements ride the same
signaling; media rides the peer connections.

---

## 4. Backpressure and bandwidth math

### 4.1 Per-track budgets (defaults used by the quality tiers)

| Track                         | Bitrate budget                   | Notes                                   |
| ----------------------------- | -------------------------------- | --------------------------------------- |
| Opus audio                    | ~32–50 kbps                      | constant; never the bottleneck          |
| 720p30 video                  | ~1.0–1.5 Mbps                    | default camera tier                     |
| 480p30 video                  | ~600–900 kbps                    | early network downgrade                 |
| 360p15 video                  | ~250–400 kbps                    | low-end / weak uplink                   |
| Screen share 1080p30          | ~2–4 Mbps                        | high-motion content can spike higher    |
| Data channel (reactions/chat) | ≪ 64 KB/message, throttle bursts | SCTP cap; `bufferedAmount` backpressure |

### 4.2 The N-person uplink formula

```
uplink_required(N) ≈ (N − 1) × camera_bitrate + screen_bitrate (if sharing)
downlink_required(N) ≈ Σ over remotes of their camera_bitrate
```

Examples (720p30 ≈ 1.5 Mbps):

| N   | Uplink per peer | Verdict                                  |
| --- | --------------- | ---------------------------------------- |
| 2   | 1.5 Mbps        | any connection                           |
| 4   | 4.5 Mbps        | most home/mobile uploads OK              |
| 6   | 7.5 Mbps        | marginal on mobile; expect quality drops |
| 8   | 10.5 Mbps       | requires fiber/cable upload; use an SFU  |

`AdaptiveQualityController` reads `availableOutgoingBitrate` (GCC / RFC 8888)
and downgrades tiers with hysteresis, so mesh calls degrade _gracefully_
instead of failing — but the math above is why a 10-person mesh is
audio-only in practice.

### 4.3 Signaling backpressure

Signaling is JSON envelopes over backend pub/sub (see
`docs/features/scaling.md` §4 for rate math). Rules that keep the mesh stable:

- **ICE coalescing**: candidates are emitted per event; adapters coalesce
  bursts (transport package).
- **`bufferedAmount`**: the data channel (`DataChannelBus`) is used for
  reactions/chat; apps should throttle reaction spam (≥ ~250 ms between
  sends) and watch `bufferedAmount` for chat bursts.
- **Per-sender `seq`**: `OrderedMessageBuffer` dedupes/reorders per
  `sessionId`, so unordered backends can't double-deliver SDP/ICE.
- **`targetSenderId`**: offers/answers/ICE are addressed to one peer, so a
  broadcast-only backend doesn't make every peer process everyone's SDP.

---

## 5. The SFU path (`SfuGateway`)

When a call outgrows the mesh, media moves to a selective-forwarding unit.
vidcall ships the **contract**, not the server:

- `SfuGateway` (`packages/sfu-gateway/src/sfu-gateway.ts`): `join(roomId,
participantId, opts)`, `onTrack(cb)`, `close(roomId?)`.
- `SfuSession` (returned by `join`): `publishTrack(trackId, kind, opts)`,
  `subscribe(participantId, opts)`, `setPreferredLayers(trackId, layer)`,
  `requestKeyframe(trackId)`, `handleOffer/handleAnswer/addIceCandidate`,
  `leave()`.
- `SfuRouter` (`packages/sfu-gateway/src/sfu-router.ts`): pure logic that
  validates room membership and maps wire `sfu` envelopes onto the session —
  unit-testable without media.
- `MediasoupAdapter`: reference `SfuGateway` implementation on mediasoup
  (maps `join` → `createWebRtcTransport`, `publishTrack` → `produce`,
  `subscribe` → `consume`, `setPreferredLayers` → `consumer.setPreferredLayers`,
  `requestKeyframe` → `producer.requestKeyFrame`).

### 5.1 Why a contract, not a bundle

The research (webrtc-js.md §3.3) compared mediasoup, LiveKit, Janus, and
others and concluded: bundling `mediasoup-client`/`livekit-client` would
couple vidcall to one vendor's protocol and signaling, contradicting the
"pluggable everywhere" mandate. The `SfuGateway` interface is vidcall's own
small contract so **any** SFU (mediasoup, LiveKit, Janus, Jitsi Videobridge,
custom) can be adapted — see `docs/features/scaling.md` §2 for the options
and how each maps.

### 5.2 SFU topology

```
        ┌─────────── signaling: backend pub/sub (unchanged) ───────────┐
        │                                                              │
     Alice                                                        Bob
        │  ▲                                                      │  ▲
   publish│  │ subscribe                                       pub│  │sub
        ▼  │                                                      ▼  │
   ┌──────────────────────────  SFU  ──────────────────────────────┐
   │  Alice's track ──► forward ──► Bob's subscription (per-layer) │
   │  Bob's track   ──► forward ──► Alice's subscription           │
   └────────────────────────────────────────────────────────────────┘
```

Per peer: **1 uplink** (encode once, simulcast/SVC layers if supported),
**N−1 downlinks** (the server forwards one layer per subscriber). The
bandwidth formula becomes:

```
uplink_required(N) ≈ 1 × camera_bitrate          (same for every N!)
downlink_required(N) ≈ Σ remote bitrates at their subscribed layers
```

### 5.3 Wire flow (SFU mode)

Same envelope, same backend — new `sfu` action type and SDP/ICE addressed to
the gateway participant:

```
A: sfu{publish, trackId, kind}  ──►  router → session.publishTrack(trackId, kind)
A: offer{sdp} (target 'sfu')    ──►  session.handleOffer(offer) → adapter produces
A: sfu{subscribe, senderId:B}   ──►  session.subscribe('B', {layers:['h','m','l']})
A: offer{sdp} (target 'sfu')    ──►  session.handleOffer → consumer created → answer
A: sfu{layer-change, layer:'m'} ──►  session.setPreferredLayers(trackId, 'm')
A: sfu{keyframe-request}        ──►  session.requestKeyframe(trackId)
A: sfu{leave}                   ──►  session.leave()
```

`SfuRouter.handle(envelope)` validates that the sender is a room member
(`isParticipant`) and has a joined session (`registerSession`), then forwards;
invalid sends emit typed errors (`not-a-participant`, `not-joined`,
`unknown-action`, `invalid-payload`, `gateway-error`).

---

## 6. Recommended topologies per use case

| Use case                              | Participants | Topology                            | Why                                                                              |
| ------------------------------------- | ------------ | ----------------------------------- | -------------------------------------------------------------------------------- |
| 1:1 sales/support/tutoring            | 2            | **mesh**                            | one pc each way; no infra                                                        |
| Team standup / small meeting          | 3–4          | **mesh**                            | 3 uplinks per peer ≈ 4.5 Mbps; fine on office/home                               |
| Family call (mixed devices)           | 4–6          | **mesh with quality caps** or SFU   | iOS Safari decode limits; cap tiers via `AdaptiveQualityController`              |
| Classroom / lecture                   | 10–50        | **SFU** (mediasoup/LiveKit)         | mesh bandwidth math breaks at ~6                                                 |
| Webinar (few speakers, many viewers)  | 100–10k      | **SFU + viewer-only subscriptions** | viewers subscribe audio-only or lowest layer                                     |
| Large audio-only meeting              | 20–100       | mesh (audio) or SFU                 | Opus is cheap; mesh OK to ~20–30 on good networks                                |
| Screen-share-heavy demo               | 3–8          | **SFU**                             | screen bitrate 2–4 Mbps × N−1 downlinks is brutal in mesh; SFU forwards one copy |
| Recording-first (compliance, classes) | any          | **SFU + server egress**             | see `docs/features/scaling.md` §5                                                |

**Migration path:** start with mesh (`Room`), keep the signaling layer
identical, and when metrics (packet loss, bitrate tiers, CPU) say the call is
outgrowing the mesh, swap the media plane to an `SfuGateway` — the app's
`Room` API surface (`publish`, `track` events, controls) stays the same.

---

## 7. How signaling + wire protocol support each model

| Wire primitive                                                | 1:1                           | Mesh                              | SFU                                                            |
| ------------------------------------------------------------- | ----------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `join` / `leave` (presence)                                   | ✓                             | ✓                                 | ✓                                                              |
| `offer` / `answer` / `ice`                                    | peer-addressed                | peer-addressed (`targetSenderId`) | addressed to the gateway participant (`targetSenderId: 'sfu'`) |
| `presence` (backend-native)                                   | ✓                             | ✓                                 | ✓                                                              |
| `reaction` / `chat`                                           | room broadcast + data channel | room broadcast + data channel     | room broadcast + data channel                                  |
| `screen-share`                                                | ✓                             | ✓                                 | ✓                                                              |
| `quality-warning`                                             | ✓                             | ✓                                 | ✓                                                              |
| `sfu` (publish/subscribe/layer-change/keyframe-request/leave) | —                             | —                                 | ✓                                                              |
| `ping` / `pong` (heartbeat)                                   | ✓                             | ✓                                 | ✓                                                              |

The engine owns ordering/idempotency/glare (`OrderedMessageBuffer`,
`PeerConnectionManager` perfect negotiation) so backends stay dumb pipes —
the same backend adapter set (Supabase/Convex/Firebase/Appwrite/Postgres/
SQLite/custom) works for all three models unchanged.

**Related:** `docs/features/scaling.md` (mesh → SFU migration, media server
options, simulcast/SVC, signaling at scale, recording) · `docs/features/controls.md`
(local mute/camera/screen-share/reactions/device controls).
