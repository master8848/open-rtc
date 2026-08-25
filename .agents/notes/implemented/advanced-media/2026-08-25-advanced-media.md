# Agent Note: Advanced media and product features

Status: implemented

Rationale: long-tail calling product needs WHIP/WHEP/HLS/RTMP ingress/egress, transcription, denoise/background polish, push/lobby/breakout, webhooks/CDR without bloating minimal install.

Files: `plans/06-advanced-media.md` → `docs/plans/archive/06-advanced-media.md`; behavior in `docs/media.md` (WHIP/WHEP/egress/transcription) + `docs/features/scaling.md` + `packages/core/src/media/whip-transport.ts:35` / `packages/core/src/media/whep-transport.ts` / `packages/core/src/media/egress.ts` / `packages/server/src/egress.ts` / `packages/core/src/media/transcription.ts:31` / `packages/core/src/media/denoise-processor.ts` / `packages/core/src/media/virtual-background-processor.ts` / `packages/server/src/webhooks.ts` / `packages/server/src/push.ts` / `protocol/schema.json` transcript type + `protocol/fixtures/transcript.json`.

Decisions: gateway ingest via POST /whip sdp offer→answer over PlainTransport, egress to HLS/RTMP via same EgressStorage; transcript additive envelope with client SpeechRecognition then SFU STT; processors lazy imported as MediaProcessor with Safari fallback warning; push/lobby/breakout/webhooks isolated subpaths, core stays zero-dep.
