# Recording — client, SFU egress, storage

Current behavior for `packages/core/src/recording/*`, `packages/server/src/recording.ts`, `packages/server/src/egress.ts`, `packages/core/src/media/egress.ts`.

Surface: `room.recording` is `RoomRecordingFacade` (`packages/core/src/recording/room-recording-facade.ts:74`) wrapping `CompositeRecordingHook` + optional `RecordingUploader`. Events `recording:started|stopped|error|blob-chunk`, methods `startRecording`/`stopRecording`/`pause`/`resume`/`getStatus` (`packages/core/src/recording/room-recording-facade.ts:118`).

Modes behind one surface: `client` composites `localStream`+`remoteStreams[]` via `MediaRecorder` into `.webm` chunks; `sfu-selective` writes one file per SFU `Consumer`; `sfu-composite` mixes via `ffmpeg`/`gstreamer` to `mp4`/`webm`/`m3u8`. `RecordingMode` and `RecordingLayout` (`grid|spotlight|custom`) are in `packages/core/src/recording/recording-hook.ts`. `room.recording.startRecording({ mode, localStream, remoteStreams, layout, egress:{hls,rtmpUrl}, encryption, timesliceMs })` selects mode; default `client` on mesh, `sfu-composite` when `media.kind==='sfu'`.

Client flow: `CompositeRecordingHook` composes streams, emits `blob-chunk` with `index`; `FetchRecordingUploader` (`packages/core/src/recording/recording-uploader.ts`) `POST /recordings/:id/chunk?index=n` + `POST .../finalize`. SFU flow: `SfuGateway.egress` → `EgressWorker` (`packages/core/src/recording/sfu-egress.ts:21` `createEgressWorker`, `packages/core/src/media/egress.ts`) consuming SFU `Consumer`s via `PlainTransport` and writing to same `RecordingStorage`.

Storage: `RecordingStorage` interface `saveChunk/finalize/getStream/delete` (`packages/server/src/recording.ts:24`) with `FinalizeManifest` (`packages/server/src/recording.ts:35`) fields `sessionId`, `chunks`, `bytes`, `finalizedAt`, optional `encrypted`, `keyId`, `mimeType`, `mode`. `DiskRecordingStorage` (`packages/server/src/recording.ts:64`) layout `dir/<sessionId>/chunk-000000`+`manifest.json`; `S3RecordingStorage` (`packages/server/src/recording.ts:166`) via `fetch`+SigV4 `aws-sigv4.ts`, prefix `prefix/sessionId/chunk-...`+`manifest.json`.

Server API: `POST /rooms/:roomId/recordings/start` → `{sessionId}`, `POST /rooms/:roomId/recordings/:id/chunk {index,blob}` → `204`, `POST /rooms/:roomId/recordings/:id/finalize` → `{chunks,bytes,manifestUrl}`, `GET /rooms/:roomId/recordings/:id/manifest`, `GET /rooms/:roomId/recordings/:id/stream` with `Range`, `DELETE /rooms/:roomId/recordings/:id` (`packages/server/src/http.ts`, `packages/server/src/recording.ts:269`).

Encryption: when `encryption:{key,keyId}` is set, `RoomRecordingFacade.uploadChunk` (`packages/core/src/recording/room-recording-facade.ts:208`) encrypts each `Blob` with AES-GCM 12-byte nonce prepended (`packages/core/src/recording/encryption.ts:29` `encryptBlob`/`decryptBlob`) and `manifest.encrypted=true`+`keyId`; key never persisted. With `policy.e2eeRequired` (`packages/server/src/core.ts:129`), egress that needs plaintext fails `code:'e2ee-blocks-egress'` (`packages/core/src/recording/room-recording-facade.ts:131`) or records ciphertext with `keyId`.

Lifecycle: `Store.RecordingSession` `expiresAt` is reaped by server cron `DELETE /recordings/:id`; `DiskRecordingStorage.delete` (`packages/server/src/recording.ts:128`) and S3 lifecycle rule are second layer; `GET /stream` supports `Range` (`packages/server/src/recording.ts:105/281`).

Related: `packages/server/README.md` (Disk vs S3 prefix, TTL, SigV4), `docs/security.md` (ACL `caps.record`, policy `allowRecording`), `docs/media.md` (SFU egress worker), `docs/plans/archive/02-recording.md` (archived rationale).
