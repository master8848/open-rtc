# 01 — Security: Secure and Non-Secure Modes

> Dependency: none. This phase can land before or in parallel with SFU wiring. It reuses `packages/server/src/auth.ts:107` and `packages/server/src/ws.ts:205`.

## Problem

- **Two audiences:** prototypes/internal tools want zero-config open mode; production wants room-scoped, identity-bound, expiring access with least privilege.
- **Today:** `verifyToken`/`issueToken` (HS256) exists and the WS relay enforces `roomId`+`participantId` binding (`ws.ts:205-234`), but `Room` has no token flow, no refresh, no role enforcement at the media layer, no TURN auth, and no E2EE. `RoomHub`/`InMemoryStore` have no ACL.
- **Must also support** recording ACL and E2EE-encrypted storage decisions (see `02-recording.md`).

## Design principle

**One API, two modes.** `security: 'open' | 'token'` (default `'open'` for dev, `'token'` for prod). Secure features are additive — turning on `token` never changes the happy-path shape, only adds guards. E2EE is orthogonal: `e2ee: { key } | false`.

## API — Server (token lifecycle)

```ts
// packages/server/src/auth.ts — extend, not replace
issueToken(secret, { roomId, participantId, role, exp, claims?: { canPublish?, canSubscribe?, canRecord? } })
verifyToken(secret, token) // already constant-time via timingSafeEqual:86

// New: refresh + revocation
issueToken(secret, { roomId, participantId, role, exp: now+3600 })
createTokenEndpoint({ secret, getPolicy }) // POST /auth/token — already in http.ts, extend with policy claims
verifyTokenWithRotation({ secrets: [current, previous], token }) // key rotation grace window
revokeToken(jti) // optional Redis set; v1 can be stateless + short TTL
```

Server config:

```ts
createServices({
  store,
  auth: secret ? { secret, requireToken: true } : undefined, // open vs secure
  turn: { secret, ttlSec: 86400 }, // see TURN section
  e2ee: { required: false }, // when true, SFU refuses unencrypted tracks
})
```

HTTP/WS guards (already in `ws.ts:138-182` and `http.ts`):

- `GET /ws?roomId=&token=` → `verifyToken` before `join` (`ws.ts:151-154` token capture, `authenticateSocket:205`). On fail: error envelope + `close(4401)`.
- `POST /rooms/:id/join`, `/signal`, `/recordings/*` → `Authorization: Bearer <token>` header check.
- `targetSenderId` unicast is still filtered server-side; secure mode logs `forbidden` not `unauthorized` when room/identity mismatch (`AuthError:58`).

Client config:

```ts
const room = new Room({
  roomId, selfId, transport,
  auth: { token, onTokenExpired: () => fetch('/auth/token').then(r=>r.text()) },
  e2ee: { key: await deriveKey(passphrase) } | false,
  iceServers: await fetchTurnCredentials(token), // or static
});
// Room internally re-emits 4401 as 'auth:error' and retries once with refreshed token.
```

## Token design (keep HS256, extend claims)

Keep `header {alg:'HS256',typ:'JWT'}` + `payload {roomId, participantId, role, exp, iat}` (`auth.ts:121-124`). Add optional claims without breaking verify:

```ts
type TokenClaims = {
  roomId: string; participantId: string; role: 'participant'|'admin';
  exp: number; iat: number;
  jti?: string; // revocation id
  caps?: { publish?: boolean; subscribe?: boolean; record?: boolean; moderate?: boolean };
  e2ee?: boolean; // holder asserts E2EE capability
}
```

- `role:'admin'` keeps current semantics (`AuthError:forbidden` vs 401). Add `caps` for fine-grained moderation (kick/mute/lock) without overloading `role`.
- TTL default `DEFAULT_TOKEN_TTL_SECONDS:53` = 3600s stays. Clients refresh at `exp - 120s`.
- Rotation: `verifyTokenWithRotation` tries each secret with `safeEqual:86`; server rolls `secrets[0]` as signer.

## E2EE (SFrame / Insertable Streams)

Goal: media confidentiality even if SFU/storage is compromised. Align with `docs/research/comparison.md` E2EE row and LiveKit SFrame.

```ts
// packages/core/src/e2ee.ts (new)
interface E2eeConfig {
  key: CryptoKey | Uint8Array; // raw 128/256-bit
  ratchetWindowMs?: number; // default 0 — no ratchet in v1
}
class SFrameProcessor implements MediaProcessor {
  constructor(key: CryptoKey) {}
  transform(track: MediaStreamTrack): MediaStreamTrack // via RTCRtpScriptTransform or insertable streams
}

// Room wiring
const room = new Room({ roomId, selfId, transport, e2ee: { key } });
// Under the hood: set RTCRtpSender/Receiver transform; SFU is told `e2ee:true` and skips decode.
```

Details:

- Feature-detect `RTCRtpScriptTransform` (Worker) → `MediaStreamTrackProcessor` + `TransformStream` with `SFrame` AES-GCM (use `libsframe` or pure JS `SubtleCrypto` AES-GCM). Safari fallback: `insertable streams` (`RTCRtpSender.createEncodedStreams`). If neither: `quality-warning` + `error.code='e2ee-unsupported'` and refuse `required:true`.
- Key distribution: app-provided (derive from token/passphrase). v1 no in-band key exchange; document `room.setE2eeKey(newKey)` for rotation (re-sets transform on all senders/receivers).
- SFU path: E2EE-encrypted frames are opaque; SFU forwards without decrypt. Recording egress must either reject (`required:true` → `recording.error 'e2ee-blocks-egress'`) or record ciphertext with key id (decrypt offline).
- Content protected vs transport protected: DTLS-SRTP always on (`PeerConnectionManager` default); SFrame is second layer.

## TURN — authenticated, short-lived credentials

~10–20% of calls fail without TURN (symmetric NAT). Current `iceServers` is passthrough (`room.ts:206`).

Add `packages/server/src/turn.ts`:

```ts
// RFC 5389 TURN REST API (coturn): HMAC-SHA1(user = expiry:participantId)
function issueTurnCredentials({ secret, participantId, ttlSec }) 
  -> { urls: string[], username: string, credential: string }

GET /turn/credentials  Authorization: Bearer <token>
  -> { iceServers: RTCIceServer[] } // coturn `turn:` + `turns:` URLs from config
```

- Server holds `turn.secret` (HMAC key) + `turn.urls`. Credentials are time-bound (`expiry = now + ttlSec`), no DB.
- Client: `iceServers` can be `() => fetch('/turn/credentials', {headers:{Authorization}})` or `Room` fetches lazily before first `RTCPeerConnection` (`ensurePeer:984`). Cache until `expiry - 60s`.
- OBS: `icecandidateerror` telemetry -> `debug('ice:turn-failed')` for ops.

## Room policy & moderation (secure mode only)

Extend `Store.Room.metadata.policy`:

```ts
type RoomPolicy = {
  locked?: boolean;              // no new joins except admin
  allowRecording?: boolean;      // gate recording facade
  allowedCodecs?: string[];      // e.g. ['VP8','H264']
  moderatorIds?: string[];       // can kick/mute/lock
  e2eeRequired?: boolean;
  maxParticipants?: number;      // already in core.ts:116
}
```

Enforced in `packages/server/src/core.ts:joinRoom` + `handleSignal` + `SfuRouter` (participants check: `sfu-router.ts:126 isParticipant`). Client `room.moderate({ action:'kick'|'mute'|'lock', targetId })` is a `control` DataChannel message validated server-side.

## Non-secure (open) mode — keep zero-friction

- `services.auth === undefined` keeps legacy behavior (`ws.ts:82` `services.relay = hub` open mode). No token header required.
- Docs label open mode as **dev only**; `room.ts` debug warns `auth:missing-in-prod` when `NODE_ENV===production` and `auth` absent.
- E2EE and TURN still work in open mode (app supplies key/iceServers directly); just no token gate.

## Storage & compliance notes

- Tokens are HS256 HMAC — secret never leaves server. No RSA/JWKS in v1; can add later as `alg:'RS256'` without breaking verify (check `hdr.alg` already: `auth.ts:155`).
- `safeEqual:86` + `timingSafeEqual` stays; add `jti` revocation only if Redis present (`S1` store -> `SET jti revoked EX ttl`).
- Recording blobs: when `e2eeRequired`, server marks `RecordingSession.encrypted=true`; `Disk`/`S3` storage is ciphertext-only (key never stored). See `02-recording.md`.

## Acceptance

- [ ] `Room({ auth })` + `onTokenExpired` refresh loop; WS 4401 mapped to `room.emit('auth:error')`.
- [ ] `GET /turn/credentials` + coturn guide; example `examples/server` demonstrates.
- [ ] SFrame processor behind `room.e2ee` with Safari fallback and `quality:warning` when unsupported.
- [ ] Policy `locked`/`moderatorIds` enforced in `core.ts` + `SfuRouter`.
- [ ] Docs: open vs secure matrix + key-rotation runbook.

## Out of scope (defer)

Double-Ratchet / sealed sender (Signal parity), per-track E2EE keys, E2EE data channels (SCTP) — document as gaps.
