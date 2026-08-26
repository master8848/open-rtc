# Deployment guide — from localhost to production

Ship the example server with TLS, TURN, auth, and storage that survives restarts.

## 1. Fix open mode before you deploy

`examples/server/server.mjs:23` runs `createServices({ store: new InMemoryStore() })` with no `auth`. That is local-dev only. In production pass `auth.secret` and a persistent store:

```ts
import { createServices, InMemoryStore } from '@mbsks/openrtc-server';
import { SqliteStore } from '@mbsks/openrtc-server/stores/sqlite';
const services = createServices({
  store: new SqliteStore({ path: './vidcall.db' }),
  auth: { secret: process.env.VIDCALL_SECRET! },
});
```

Mint tokens server-side via `POST /vidcall/auth/token` or `issueToken(secret, { roomId, participantId, role })` (`packages/server/src/auth.ts:127`). Clients send `Authorization: Bearer <token>` on REST and `?token=` on `ws://.../ws?roomId=`. Missing or expired tokens get close code `4401` (`packages/server/src/ws.ts:210`).

## 2. TLS for getUserMedia

Browsers gate `getUserMedia` to secure contexts: `http://localhost` works, `http://192.168.x.x` does not. Terminate TLS at your reverse proxy (Caddy, nginx, Fly, Vercel) and forward `wss://`. Health-check the relay with `GET /vidcall/rooms/:id/state` (200 when up). No extra config in vidcall itself.

## 3. TURN — STUN is not enough

Pass `iceServers` from the server's TURN issuer (`packages/server/src/turn.ts:38`) so ~10–20% of calls behind symmetric NATs still connect:

```ts
// server: createServices({ store, turn: { secret: process.env.VIDCALL_TURN_SECRET!, urls: ['turn:turn.example.com:3478'] } })
 // client: fetch('/vidcall/turn/credentials', { headers: { Authorization: `Bearer ${token}` } })
```

On the host, run coturn with `static-auth-secret=$VIDCALL_TURN_SECRET` and expose `turn.secret` / `turn.urls` / `turn.ttlSec` (`packages/server/README.md` Turn section). See `docs/security.md:15` and `docs/research/webrtc-js.md:414`.

## 4. Choose a relay for horizontal scale

HTTP `handleSignal` already calls `relay.broadcast` (`packages/server/src/services.ts`); wire the WS relay with a pluggable `Relay`:

- **Single instance**: default `RoomHub` (`packages/server/src/ws.ts:59`) is enough.
- **Multi-instance behind a LB**: `RedisRelay` (`packages/server/src/relays/redis-relay.ts:45`) on `vidcall:room:{roomId}` (needs `ioredis`/`redis` peer dep) — pick this for burst ICE and >20 participants.
- **Postgres only**: `PostgresNotifyRelay` (`packages/server/src/relays/postgres-notify-relay.ts`) uses one dedicated `pg.Client` `LISTEN vidcall_room` with 7 KB `Chunker` (`docs/limits.md:11`). Keep `LISTEN` off the pool.

Wire: `attachWebSocketRelay(server, services, { relay })` and set `services.relay = relay` so REST and WS fan out together (`docs/transport.md:9`, `docs/limits.md:35`).

## 5. Recording storage and lifecycle

Default is `DiskRecordingStorage` (`packages/server/src/recording.ts:64`) at `dir/<sessionId>/chunk-000000` + `manifest.json`. For prod use `S3RecordingStorage` (`packages/server/src/recording.ts:166`) via SigV4 `fetch` (no AWS SDK) and set an S3 lifecycle rule plus the server cron `expireRecordings` to reap `Store.RecordingSession.expiresAt` (`docs/recording.md:17`).

Related: `packages/server/README.md` (REST/Store/relay surface), `docs/limits.md` (ceilings), `docs/security.md` (auth/TURN), `docs/transport.md` (relays).
