# Agent Note: Client, SFU, and egress recording

Status: implemented

Rationale: recording was tab-bound MediaRecorder composite with no SFU path, no encryption/ACL, no retention or Range, in-process relay blocked second instance.

Files: `plans/02-recording.md` → `docs/plans/archive/02-recording.md`; behavior in `docs/recording.md` + `packages/core/src/recording/room-recording-facade.ts:74` / `packages/core/src/recording/encryption.ts:29` / `packages/core/src/recording/sfu-egress.ts:21` / `packages/server/src/recording.ts:24` RecordingStorage / `packages/server/src/http.ts` recording routes / `examples/server/server.mjs` Disk example.

Decisions: one room.recording surface with modes client/sfu-selective/sfu-composite and layout/egress options; same RecordingStorage for Disk and S3 (SigV4 fetch); encrypted chunks via AES-GCM 12B nonce + manifest encrypted/keyId, key never stored; e2eeRequired blocks plaintext egress with e2ee-blocks-egress; Store expiresAt + server cron + S3 lifecycle for retention.
