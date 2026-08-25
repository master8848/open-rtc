# Agent Note: Secure and non-secure modes with policy, E2EE, TURN

Status: implemented

Rationale: open mode suffices for dev but prod needs room-scoped identity-bound expiring access with least privilege; 10-20% calls need TURN; SFU/storage compromise needs SFrame confidentiality without changing happy-path shape.

Files: `plans/01-security.md` → `docs/plans/archive/01-security.md`; behavior in `docs/security.md` (auth/E2EE/TURN) + `packages/server/src/auth.ts:127` issueToken / `packages/server/src/auth.ts:164` verifyToken / `packages/server/src/auth.ts:278` verifyTokenWithRotation / `packages/server/src/auth.ts:306` revokeToken / `packages/server/src/ws.ts:210` authenticateSocket / `packages/server/src/turn.ts:38` issueTurnCredentials / `packages/core/src/e2ee.ts` SFrameProcessor / `packages/server/src/core.ts:129` RoomPolicy / `packages/server/README.md#authentication--tokens`.

Decisions: keep HS256 compact JWT with roomId+participantId+role+exp/iat and optional jti/caps/e2ee; constant-time safeEqual, no RSA until needed; open mode preserved, secure additive; E2EE orthogonal via MediaProcessor chain last; TURN via coturn HMAC-SHA1 time-bound creds, bearer-guarded GET /turn/credentials.
