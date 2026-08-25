# 06 — Advanced Media & Product Features

> Depends on `03-media-topology.md` (MediaTransport seam, SFU) and `04-transport-signaling-scale.md` (relay/scale). Security from `01-security.md`, recording from `02-recording.md`. All features are additive behind feature flags / optional subpaths.

## Goal

Cover the long tail that makes a calling product shippable — live streaming, transcription, polish (denoise/bg/active-speaker), reachability (TURN already in 01, push/lobby/breakout here), and observability — without bloating the minimal install.

## 1. Ingress / Egress: WHIP / WHEP / HLS / RTMP

| Direction | Protocol | What it does |
|-----------|----------|--------------|
| Ingest (publish from outside WebRTC) | **WHIP** (RFC) `POST /whip/:roomId` SDP offer → answer | OBS / broadcaster → SFU `PlainTransport` producer → fan-out as normal `video` track |
| Egress (consume outside WebRTC) | **WHEP** `POST /whep/:roomId` | SFU consumer → SDP answer for external player |
| Egress (broadcast) | **HLS** `m3u8` + **RTMP** `rtmp://` | SFU consumer(s) → `ffmpeg`/`gstreamer` → `RecordingStorage`-like `EgressStorage` (S3/Disk) or RTMP push |

API:

```ts
// SFU gateway (03 MediaTransport)
gateway.ingestWhip(roomId, sdpOffer): Promise<sdpAnswer> // or WhipMediaTransport
gateway.egress(roomId, { hls?: boolean; rtmpUrl?: string; whep?: boolean }): Promise<{ hlsUrl?, whepUrl? }>
gateway.stopEgress(roomId): Promise<void>

// Room convenience (delegates to media.kind==='sfu')
await room.startEgress({ hls: true, rtmpUrl: 'rtmp://...' });
await room.stopEgress();
```

- Reuses `MediasoupAdapter` `PlainTransport` / `DirectTransport` + `Consumer`. `RecordingStorage` abstraction already handles `S3` SigV4 (`recording.ts:154`) — extend to `EgressStorage` (same interface, different prefix).
- Server: `POST /whip/:roomId` and `/whep/:roomId` are SFU-adjacent HTTP endpoints (not core `Store`). Guard with token (`Authorization: Bearer`) when `services.auth` set.
- Install: `bun add @mbsks/openrtc-sfu-gateway` already; WHIP/WHEP are subpaths, no new SDK. `ffmpeg` is an external binary — document as infra dep for egress.

## 2. Transcription / STT

```ts
room.on('transcript', (e: { participantId: string; text: string; isFinal: boolean; lang?: string }) => {})
await room.startTranscription({ lang: 'en-US', interim: true });
await room.stopTranscription();
```

Two sources, same event:

1. **Client STT** (zero infra): `Web Speech API` or on-device `Whisper.wasm` → `DataChannelBus` `transcript` message → `room.emit('transcript')`. Works mesh.
2. **Server STT** (prod): SFU audio `Consumer` → STT service (Whisper / cloud) → `transcript` envelope (`protocol/schema.json` additive `transcript` type) → relay → `room.on('transcript')`. Also webhooks `transcript.interim/final`.

- Envelope additive: `{ v, type:'transcript', roomId, senderId, sessionId, ts, seq, payload:{ text, isFinal, lang } }` — add to `types.ts` + `fixtures/`.
- Recording + transcript alignment: `RecordingSession` gets `transcriptUrl` sidecar.

## 3. Polish processors (MediaProcessor chain from 03)

All run **before** `media.publish()` as `MediaProcessor.transform(track) -> track`:

| Processor | Tech | Fallback |
|-----------|------|----------|
| **Noise suppression / AEC control** | WASM RNNoise + `MediaStreamTrackProcessor` | `ControlsManager` `DEFAULT_AUDIO_CONSTRAINTS` (`controls/ControlsManager.ts:36` `echoCancellation/noiseSuppression/autoGainControl`) only |
| **Virtual background / blur** | SelfieSegmentation + canvas composite | no-op + `quality:warning` |
| **Active speaker** | `inbound-rtp audioLevel` + `AnalyserNode` hysteresis → `room.on('active-speaker', string[])` + `speaker {speaking,audioLevel}` envelope | — |
| **E2EE SFrame** | `RTCRtpScriptTransform` / insertable streams (01) | `error.code='e2ee-unsupported'` when `required:true` |

```ts
room.useProcessor(new RnnoiseProcessor());
room.useProcessor(new VirtualBackgroundProcessor({ modelUrl: '/models/selfie_segmentation.tflite' }));
room.useProcessor(new SFrameProcessor(key)); // last
room.setTile(participantId, { visible, width, height, priority }); // tile-aware layer
```

- `MediaProcessor` is interface-only; heavy WASM models are lazy `import()` so minimal install pays ~0 B.
- `quality` policy stays send-side pure (`quality/src/adaptive-quality-controller.ts:115`); receive-side adaptive is `setPreferredLayers` (SFU) or `track.enabled=false` (mesh worst-peer `room-quality.ts:543`).

## 4. Reachability & product flows

| Feature | Server | Client |
|---------|--------|--------|
| **TURN credentials** (01) | `GET /turn/credentials` (coturn REST HMAC) | `iceServers: await fetchTurnCredentials(token)` |
| **Push notifications** | `packages/server/src/push.ts` — FCM/APNs via app-provided keys; trigger on `join` when participant offline | `room.onPush(cb)` registers token via `setPresence` metadata |
| **Lobby / waiting room** | `RoomPolicy.locked` (01) + `POST /rooms/:id/lobby/admit` (admin only) | `room.on('lobby:waiting')`, `room.admit(participantId)` |
| **Breakout rooms** | `POST /rooms/:id/breakouts` → child `roomId`s with same gateway | `VidcallClient.getRoom(breakoutId)` — same `Room` class |
| **Moderation** | `room.moderate({ action:'kick'|'mute'|'lock', targetId })` → `control` DataChannel + server guard | `room.on('moderation', ...)` |
| **Raise hand / polls / reactions burst** | `poll {question,options}` + `vote` envelopes (`protocol` additive) | `room.poll(...)`, `room.on('poll', ...)` |
| **Screen share guard** | `announceScreenShare('start'|'stop')` (ship `room.ts:643`) + `contentHint='detail'` + second transceiver; iOS typed error | `ControlsManager.toggleScreenShare` already does `replaceTrack` (no reneg) |

## 5. Webhooks / CDR / admin

```ts
// packages/server/src/webhooks.ts
interface WebhookConfig { url: string; secret: string; events: ('join'|'leave'|'recording.finalized'|'transcript.final'|'lobby.waiting')[] }
services.webhooks = [{ url, secret, events }] // HMAC X-Vidcall-Signature
// CDR: append-only log per room (Store extension) for billing/analytics
```

- Signed `POST` with `X-Vidcall-Signature: hmac(body, secret)` + retry with backoff.
- Admin: `role:'admin'` token can `closeRoom` / `deleteRoom` / `listSignals` (`auth.ts:26` roles).

## 6. Analytics & quality telemetry

- Client: `room.getCallStats(): Promise<RTCStatsSnapshot>` (already merged `room-quality.ts:543` worst-peer + `quality:changed` webhook). Expose `connection-state` / `ice-connection-state` / `quality:warning` ring buffer for devtools (`05`).
- Server: `Store` `listSignals` + `Relay` `clientCount` → room concurrency metrics; SFU `Consumer` bitrate → egress health.
- Optional ML: `onstats` anomaly detector (defer — document as hook).

## 7. Install & bundle discipline

| Add | What you pay |
|-----|-------------|
| `@mbsks/openrtc-core` | <15 kB gz |
| `+ @mbsks/openrtc-sfu-gateway` | +mediasoup types only (no native) |
| `+ WHIP/WHEP/HLS` | +egress worker (server infra, not bundle) |
| `+ transcription` | `+ @mbsks/openrtc-transcription` (STT SDK isolated) |
| `+ processors` (rnnoise/bg) | lazy WASM, 30–200 kB on demand |
| `+ push` | `+ @mbsks/openrtc-server/push` (FCM/APNs SDK isolated) |

No feature lands in `core` unless it is zero-dep or lazy.

## Acceptance

- [ ] `POST /whip|whep` + `startEgress({hls,rtmp})` against `MediasoupAdapter` PlainTransport.
- [ ] `transcript` envelope + `room.on('transcript')` (client STT first, server STT behind flag).
- [ ] `VirtualBackground` / `Rnnoise` processors as lazy subpaths with Safari fallback warning.
- [ ] Push + lobby + breakout behind `RoomPolicy` (01) + webhooks with HMAC verify.
- [ ] Docs: per-feature infra requirements + bundle cost table.

## Out of scope

MCU compositing for SIP (bridge via SFU PlainTransport when needed), AV1 hardware probe (`WebCodecs VideoEncoder.isConfigSupported`), PSTN `SipGateway.dial` (thin `SipGateway` bridging SIP INVITE ↔ SFU `Producer/Consumer` — roadmap P2 after WHIP).
