# Error handling — taxonomy and what to do

vidcall errors are machine-readable `code` strings. Check `code` before `message`.

## 1. Where codes come from

Server REST/WS always returns `{ error: { code, message, details? } }` (`packages/server/README.md:107`). Client `room.on('error', ...)` currently emits bare `Error` objects with an ad-hoc `code` field (`packages/core/src/room.ts:156`); the plan is to align both on `code` (`plans/08-coherence-dx-docs-plan.md`).

## 2. Taxonomy

| Code | Source | Meaning | Action |
|---|---|---|---|
| `room_not_found` (404) | `POST /rooms/:id/join` | room id unknown | create via `POST /rooms` or check id |
| `room_full` (409) | `joinRoom` (`packages/server/src/core.ts:129` `maxParticipants` / `packages/server/src/errors.ts:83`) | participant limit hit | surface "room is full", offer waitlist |
| `room_closed` / `room_already_exists` | REST | lifecycle guards | retry with new id or wait for reopen |
| `unauthorized` / `token_expired` (401) / `forbidden` (403) | `packages/server/src/auth.ts:75` / `packages/server/src/ws.ts:210` | missing/invalid/expired/scoped token | refresh token, then `room.join()` again; WS close `4401` maps to these |
| `e2ee-unsupported` | `packages/core/src/media/processor.ts:32` / `packages/core/src/e2ee.ts:48` | no `RTCRtpScriptTransform` nor insertable streams | disable E2EE or warn; app gates with `detectE2eeSupport()` |
| `e2ee-blocks-egress` | `packages/core/src/recording/room-recording-facade.ts:131` | `policy.e2eeRequired` blocks plaintext recording egress | record ciphertext with `keyId` or turn off `e2eeRequired` (`docs/security.md:13`) |
| `ice:turn-failed` | `packages/core/src/room.ts:829` (`icecandidateerror`) | TURN unreachable or bad `turn.secret` | check coturn logs, verify `turn.urls`/`turn.secret` (`docs/guides/deployment.md:3`) |
| `device:unavailable` / `NotAllowedError` | `getUserMedia` via `room.devices` / `room.controls` | permission denied or device unplugged | prompt for permission, offer device picker (`docs/features/controls.md:6`) |

## 3. Handling pattern

```ts
room.on('error', (err: Error & { code?: string }) => {
  switch (err.code) {
    case 'token_expired': void refreshToken().then(() => room.join()); break;
    case 'room_full': showToast('Room is full'); break;
    case 'e2ee-unsupported': setE2ee(false); break;
    default: console.error(err.code, err.message);
  }
});
ws.addEventListener('close', (e) => {
  if (e.code === 4401) handleAuthClose(e.reason); // unauthorized/token_expired/forbidden
});
```

## 4. Limits that surface as errors

Backend ceilings live in `docs/limits.md` (e.g. Postgres `7KB` chunked, Supabase `~256KB`). Exceeding `maxPayloadBytes` chunks automatically (`packages/transport/src/internal/chunker.ts:53`); rate throttles surface as transport `error` — prefer the WS relay for ICE bursts (`docs/transport.md:6`).

Related: `packages/server/README.md#rest-api` (full code table), `docs/security.md` (auth), `docs/media.md` (processor order).
