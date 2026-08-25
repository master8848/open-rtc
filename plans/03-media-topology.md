# 03 — Media & Topology: Mesh → SFU → Extensible Media

> Depends on `00-overview.md`. SFU wiring unlocks 02-recording SFU modes and 04-scale. Security knobs from `01-security.md` apply.

## Current state

- `Room` (`packages/core/src/room.ts:260`) is mesh: `Map<string,PeerEntry {pc,manager,bus}>`, `ensurePeer:970` creates `RTCPeerConnection` (or `peerFactory:984`), `PeerConnectionManager` does perfect negotiation / trickle ICE / renegotiation / `restartIce:649`. `publish:531` adds track to every peer and `negotiate('track-added')`; `subscribe:576` is a handle (`track.enabled`).
- `SfuGateway`/`SfuSession` contract (`packages/sfu-gateway/src/sfu-gateway.ts:109/146`) + `SfuRouter` (`sfu-router.ts:126`) + `MediasoupAdapter` (`mediasoup-adapter.ts`) + SDP helpers (`sdp.ts`) exist, `protocol/schema.json:429` `SfuPayload` validated, tests green — but `Room.handleEnvelope:798` `case 'sfu': break` (`room.ts:889`). No media flows through SFU.
- Adaptive quality (`packages/quality/src/adaptive-quality-controller.ts:115`, `room-quality.ts:216`) is send-side only; simulcast is `room-quality.ts:145` `setParameters(active/maxBitrate/scale)` with Safari single-stream fallback. No `scalabilityMode`, no `setCodecPreferences` ranking.
- Transport/media coupling: `Room` owns both signaling (`config.transport:200`) and media (`new RTCPeerConnection`). Single path — not wrong for v0.1, but blocks WHIP/WHEP, data-channel-only calls, and SFU migration without rewrite.

## Goal

`Room` becomes topology-agnostic. Media flows through a `MediaTransport` seam; signaling stays pluggable. SFU is opt-in, auto-switchable, and the same `Room` API works at 2 and 500 participants. Media types are extensible beyond audio/video.

## New seam: `MediaTransport`

Extract what `Room.publish/unpublish/subscribe/getPeerConnections/getSenders/restartIce` currently do directly:

```ts
// packages/core/src/media/media-transport.ts (new)
interface MediaTransport {
  readonly kind: 'mesh' | 'sfu' | 'whip' | 'whep' | 'custom';
  publish(track: MediaStreamTrack, opts: PublishOptions): Promise<TrackPublication>;
  unpublish(pub: TrackPublication): Promise<void>;
  subscribe(participantId: string, opts?: MediaSubscribeOptions & { layer?: string }): Promise<TrackSubscription>;
  setPreferredLayers?(trackId: string, layer: string): Promise<void>;
  requestKeyframe?(trackId: string): Promise<void>;
  restartIce?(participantId?: string): Promise<void>;
  getSenders(): RTCRtpSender[];
  getPeerConnections(): RTCPeerConnection[]; // for quality sampler
  onTrack(cb: (e: RemoteTrackEvent) => void): () => void;
  onConnectionState?(cb: (e: PeerConnectionStateEvent) => void): () => void;
  close(): Promise<void>;
}

class MeshMediaTransport implements MediaTransport { /* today's PeerConnectionManager × N */ }
class SfuMediaTransport implements MediaTransport { /* 1 PC to SfuSession + SfuRouter */ }
class WhipMediaTransport implements MediaTransport { /* WHIP POST SDP offer → answer */ }
```

- `Room` holds `private media: MediaTransport` selected by config (see TopologyController). All media methods delegate.
- `peerFactory` moves inside `MeshMediaTransport` / `SfuMediaTransport`; `Room.ensurePeer` disappears. `Room.getDataChannelBus` becomes `media.getDataChannelBus?.()`.
- `RoomQualityController` stays but polls `media.getPeerConnections()` / `media.getSenders()` (`room.ts:673/678`) — no change to policy engine.

## Topology controller (auto mesh → SFU)

```ts
// packages/core/src/media/topology.ts
type Topology = 'mesh' | 'sfu' | 'auto'; // default 'auto'
interface TopologyConfig {
  topology?: Topology; // default 'auto'
  autoThreshold?: number; // N where auto flips mesh→sfu, default 4
  sfu?: { gateway: SfuGateway; participantId?: string } // required when topology!=='mesh'
}

class TopologyController {
  constructor(private room: Room, private cfg: TopologyConfig) {}
  async maybeMigrate(): Promise<void> // on participant-joined/left
}
```

- `auto` matrix: ≤ threshold → `MeshMediaTransport`; > threshold → `SfuMediaTransport` (single PC to SFU). Migration: `await sfuGateway.join(roomId, selfId)` → `SfuRouter.registerSession(session)` → re-`publish` local tracks to SFU → close mesh PCs. Downgrade (everyone leaves) is optional v1 — document as manual `room.setTopology('mesh')`.
- `RoomConfig` (`room.ts:191`) gets `topology?: TopologyConfig` and `sfuGateway?: SfuGateway` (or `mediaTransport?: MediaTransport` for custom). Wiring TODO at `sfu-gateway.ts:15` and `docs/architecture.md:32` is resolved here.
- `protocol` `sfu` envelope flow (`sfu-router.ts:179 handle`, `SfuPayload:types.ts:160`) stays; `SfuRouter` is constructed per-room with `isParticipant` guard and `sfuParticipantId='sfu'`.

## Wiring SFU into Room (the TODO)

```ts
// pseudocode inside Room
constructor(config: RoomConfig) {
  this.media = config.mediaTransport ?? (
    config.topology?.topology === 'sfu' || (config.topology?.sfu && autoShouldBeSfu())
      ? new SfuMediaTransport({ gateway: config.topology.sfu.gateway, roomId, selfId })
      : new MeshMediaTransport({ peerFactory: config.peerFactory, iceServers: config.iceServers })
  );
  this.topology = new TopologyController(this, config.topology);
}

private async handleEnvelope(envelope: Envelope) {
  if (envelope.type === 'sfu') return this.media.handleSfuEnvelope?.(envelope);
  // ... existing join/leave/offer/answer/ice/reaction/chat/screen-share
}
```

- `SfuMediaTransport` owns one `RTCPeerConnection` to SFU; `publishTrack(kind,trackId)` and `subscribe(participantId)` map to `SfuSession` methods; `setPreferredLayers` maps `l/m/h` → spatial layers (mediasoup), `requestKeyframe` → `consumer.requestKeyFrame()`.
- `onTrack` events from `SfuGateway.onTrack:154` become `RemoteTrackEvent`s via `SfuRouter`.
- LiveKit second adapter: `class LivekitGateway implements SfuGateway` proves generality (≥2 impls policy `docs/architecture.md:40 D2`).

## Media-type extensibility

Today: `audio`/`video`/`screen` (`SfuKind`, `protocol/schema.json` `SfuPayload.kind`), `source: camera|microphone|screen` (`PublishOptions:152`). Fix transport layer to not assume `audio|video` only:

- Envelope `type` already extensible (`MESSAGE_TYPES` + fallback idempotent). Reserve `media-type` extensibility via `kind: SfuKind | string` and `payload.metadata.kindParams`.
- `MediaProcessor` chain handles per-type transforms before `publish`:

```ts
// packages/core/src/media/processor.ts
interface MediaProcessor {
  kind: 'e2ee' | 'denoise' | 'background' | 'custom';
  transform(track: MediaStreamTrack): MediaStreamTrack; // MediaStreamTrackProcessor → Transformer → Generator
  dispose?(): void;
}
room.useProcessor(new SFrameProcessor(key)); // 01-security
room.useProcessor(new RnnoiseProcessor()); // 06
room.useProcessor(new VirtualBackgroundProcessor({ modelUrl })); // 06
// Order: denoise → background → e2ee (e2ee last)
```

- Feature-detect `RTCRtpScriptTransform` / `MediaStreamTrackProcessor`; Safari fallback no-op + `quality:warning`.
- New media types plug in as processors + `publish` metadata without protocol break: `publish(track, { source:'screen', metadata:{ contentHint:'detail', kind:'screen' }})` already supported (`room.ts:542 metadata`); extend `kind` union when needed.

## Simulcast / SVC / codec preferences

```ts
await room.publish(track, {
  source: 'camera',
  simulcast: { layers: 3, encodings: [...] }, // maps to RTCRtpEncodingParameters
  svc: { scalabilityMode: 'L3T3_KEY' }, // VP9 SVC
  codecPreferences: ['VP9','VP8','H264'], // setCodecPreferences ordering
});
```

- `RoomQualityController` + `AdaptiveQualityController` (`quality/src/tiers.ts:18` ladder) already applies `maxBitrate/scaleResolutionDownBy/degradationPreference`; add `scalabilityMode` passthrough and `RTCRtpTransceiver.setCodecPreferences` (guard Safari `H264` fallback `docs/architecture.md D5`).
- `SfuMediaTransport.setPreferredLayers(trackId, 'l'|'m'|'h')` for receiver-driven layer switching (`SfuSession:123`); `requestKeyframe` for recovery after switch.
- Expose `room.setTile(participantId, { visible, width, height, priority })` → auto `setPreferredLayers` (SFU) or `track.enabled=false` (mesh worst-peer merge `room-quality.ts:543`).

## Active-speaker & audio levels (foundation)

- Poll `inbound-rtp.audioLevel` + `AnalyserNode` hysteresis → `room.on('active-speaker', string[])`; add `speaker {speaking,audioLevel}` to `protocol/schema.json` + `fixtures/` in same PR as `MediaTransport` (small additive change).
- Needed for tile-aware quality and UI.

## Acceptance

- [ ] `MediaTransport` seam + `MeshMediaTransport` (extracted from current Room) + `SfuMediaTransport` wiring `SfuRouter`/`SfuSession`.
- [ ] `topology: 'auto'` (threshold 4) migration demo — 5-peer room uses single SFU PC.
- [ ] `MediaProcessor` chain with E2EE last; Safari fallback warning.
- [ ] `publish({simulcast,svc,codecPreferences})` + `setPreferredLayers`/`requestKeyframe` working against `MediasoupAdapter`.
- [ ] No breaking change to existing `room.publish(track)` / `room.subscribe` call sites.

## Out of scope

WHIP/WHEP ingest/egress and transcription (see `06-advanced-media.md`); MCU mixing (SIP interop only).
