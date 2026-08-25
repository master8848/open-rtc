# 02 — Recording: Client, Server, and SFU Egress

> Dependencies: none for client/Server upload (already shipped); SFU egress needs `03-media-topology.md`. Security knobs from `01-security.md`.

## Today

- `RoomRecordingFacade` (`packages/core/src/recording/room-recording-facade.ts:61`, `recording-hook.ts`) wraps `MediaRecorder` (`media-recorder-recording-hook.ts`) + `CompositeRecordingHook` — composes `localStream` + `remoteStreams[]` into one `MediaStream`, emits `recording:started|stopped|error|blob-chunk`, uploads via `FetchRecordingUploader` (`recording-uploader.ts`) to `recordingEndpoint`.
- Server `RecordingStorage` (`packages/server/src/recording.ts:24`) has `DiskRecordingStorage:52` and `S3RecordingStorage:154` (SigV4 `fetch`, no AWS SDK `aws-sigv4.ts`) with chunked `saveChunk/finalize/getStream/delete`. Session metadata lives in `Store` (`core.ts` `startRecording/stopRecording`); bytes live in `RecordingStorage`.
- Gaps: no SFU egress (recording is whoever holds the tab), no encryption/ACL, no retention, no transcode/composite policy, and `in-process` relay means second server instance doesn't see chunks.

## Product shapes (all behind one surface)

| Mode | What it does | When to use |
|------|--------------|-------------|
| **Client composite** (ship) | Tabs composite local+remote streams via canvas+mixer → `MediaRecorder` `.webm` chunks → `POST /recordings/:id/chunk` + `POST .../finalize` | 1:1 / mesh ≤4, no SFU infra |
| **SFU selective** (new) | SFU `Consumer`s → file per producer (no mixing) → mux later | Audit, per-track retention |
| **SFU composite (egress)** (new) | SFU consumers → compositor (canvas/ffmpeg/gstreamer) → single `mp4`/`webm` + optional `m3u8` (HLS) | Large rooms, server truth |

All three share `RecordingStorage` and the same `room.recording` events. App picks via `recording.mode`.

## API — Client (keeps backward compat)

```ts
// packages/core/src/room.ts — RoomConfig addition
recording?: RoomRecordingConfig & {
  mode?: 'client' | 'sfu-selective' | 'sfu-composite'; // default 'client' (mesh), 'sfu-composite' when SFU active
  endpoint?: string; // alias of recordingEndpoint (rename, keep both until 1.0)
  mimeType?: string; // e.g. 'video/webm;codecs=vp8,opus'
  timesliceMs?: number; // MediaRecorder slice, default 2000
  encryption?: { key: CryptoKey } | false; // when e2eeRequired, encrypt before upload
}

// Room surface — unchanged events, new options
await room.recording.startRecording({
  mode?: 'client' | 'sfu-selective' | 'sfu-composite',
  localStream, remoteStreams, // client mode only
  layout?: 'grid' | 'spotlight' | { custom: LayoutSpec },
  egress?: { hls?: boolean; rtmpUrl?: string }, // sfu-composite
});
await room.recording.stopRecording();
room.recording.on('recording:started', ({ sessionId, mode }) => {})
room.recording.on('recording:stopped', ({ sessionId, chunks, bytes, manifestUrl }) => {})
room.recording.on('recording:blob-chunk', (chunk: Blob) => {})
room.recording.on('recording:error', ({ code, message }) => {})
room.recording.getStatus(): 'idle'|'recording'|'finalizing'
```

Transport-agnostic: `FetchRecordingUploader` stays `fetch`-based; no dependency on `@mbsks/openrtc-server` (`room.ts:341-344` already no server dep). `uploadChunk` chunks are `index`-ordered (existing `saveChunk(sessionId, chunk, index)`).

## API — Server

```ts
// packages/server/src/recording.ts — extend storage with encryption metadata
interface RecordingSessionMeta {
  sessionId: string; roomId: string; startedBy: string;
  mode: 'client'|'sfu-selective'|'sfu-composite';
  mimeType: string; encrypted: boolean; keyId?: string;
  manifest?: FinalizeManifest; // chunks, bytes, finalizedAt
}

// HTTP (packages/server/src/http.ts)
POST   /rooms/:roomId/recordings/start   -> { sessionId, uploadUrls? }
POST   /rooms/:roomId/recordings/:id/chunk { index, blob } -> 204
POST   /rooms/:roomId/recordings/:id/finalize -> { chunks, bytes, manifestUrl }
GET    /rooms/:roomId/recordings/:id/manifest
GET    /rooms/:roomId/recordings/:id/stream  // Range support via getStream():93/269
DELETE /rooms/:roomId/recordings/:id

// Auth: bearer token required when services.auth set; caps.record gate (01-security.md).
// ACL: participant can read only their room's recordings; admin can read any.
```

`RecordingStorage` contract unchanged (`saveChunk/finalize/getStream/delete:24-32`). Add:

```ts
interface EncryptedRecordingStorage extends RecordingStorage {
  // when session is encrypted, bytes are ciphertext; key never persisted
  getKeyId?(sessionId: string): Promise<string | null>
}
```

Disk layout stays `dir/<sessionId>/chunk-<000000>` + `manifest.json:88-89`; S3 stays `prefix/sessionId/chunk-...` + `manifest.json:177-181`. Encrypted sessions add `manifest.encrypted=true` + `manifest.keyId`.

## SFU path (new, behind `03-media-topology.md`)

```
Browser -> SFU (mediasoup Router) -> Consumer(s) -> EgressWorker -> RecordingStorage
                                   \-> PlainTransport for WHIP ingest (06)
```

- `SfuGateway` gets `egress(roomId, { composite, hls, rtmp })` and `stopEgress`. Reference impl uses `mediasoup` `Consumer` → `ffmpeg` (or `gstreamer`) via `PlainTransport`/`DirectTransport`. v1 can be `ffmpeg -i pipe:0` consuming RTP; later optimize.
- `SfuRouter` routes track events to egress; `Room` delegates `room.recording.start({mode:'sfu-composite'})` to gateway when `media.kind==='sfu'`.
- Scaling note: egress is CPU-heavy; run as separate worker process/host, not in WS relay. Same `RecordingStorage` interface.

## Encryption & non-secure vs secure

- **Open mode:** `encryption:false` default. Chunks stored as-is. No key management.
- **Secure + `e2eeRequired:false`:** optional `encryption:{key}` — client encrypts each `Blob` chunk with AES-GCM (random 12B nonce per chunk, prepend) before `saveChunk`. Server stores ciphertext; `manifest.keyId` is app-supplied, never the key. Download requires client-side decrypt.
- **Secure + `e2eeRequired:true`:** media is SFrame-encrypted end-to-end. Egress that needs plaintext must fail (`code:'e2ee-blocks-egress'`) or record ciphertext with `keyId`. Document the tradeoff.
- At-rest encryption alternative: `S3RecordingStorage` with SSE-S3/SSE-KMS — orthogonal, can combine.

## Retention, lifecycle, and ops

- `Store` `RecordingSession` gets `expiresAt?: number` (epoch ms). Server cron `DELETE /recordings/:id` after TTL; S3 lifecycle rule as second layer. `DiskRecordingStorage.delete:116` already exists.
- `GET /stream` supports `Range` (S3 `Range` header pass-through; Disk `createReadStream` with `start/end`).
- Webhook `recording.finalized` / `recording.deleted` (see `06-advanced-media.md` webhooks) for app indexing.
- Quota: `services.recordingStorage` quota check before `saveChunk` (e.g. per-room byte cap) -> `errors.recordingStorageError`.

## UI plug-and-play

- `client` mode is zero infra: `room.recording.startRecording({localStream, remoteStreams})` works with `InMemoryStore` + `DiskRecordingStorage` (`examples/vanilla` pattern).
- `sfu-*` modes are opt-in: `bun add @mbsks/openrtc-sfu-gateway` + `RecordingStorage` (S3) + egress worker. App bundle doesn't grow unless imported.

## Acceptance

- [ ] `room.recording.start({mode, layout, egress})` unified; existing `localStream`/`remoteStreams` still works.
- [ ] `manifest.encrypted` + `keyId` surfaced in `recording:stopped`.
- [ ] SFU selective + composite behind feature flag, with `ffmpeg` reference worker.
- [ ] Docs + `examples/server` showing Disk vs S3 + TTL + Range download.

## Out of scope

Transcription/STT over recordings (see `06-advanced-media.md` `transcript`), server-side editing/trimming.
