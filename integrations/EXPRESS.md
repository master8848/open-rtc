# Hosting @vidcall/server in an Express app

Mount the component's router directly inside your existing Express app — no
separate process, no proxy. The WS relay upgrades the same HTTP server, so
`/ws?roomId=...` and the REST API share one port.

```bash
npm install @vidcall/server express better-sqlite3
```

```ts
// server.ts
import express from 'express';
import http from 'node:http';
import { attachWebSocketRelay, createServices, DiskRecordingStorage } from '@vidcall/server';
import { createExpressRouter } from '@vidcall/server/express';
import { SqliteStore } from '@vidcall/server/stores/sqlite';
import Database from 'better-sqlite3';

const store = new SqliteStore(new Database('vidcall.db'));
await store.bootstrap();

const services = createServices({
  store,
  recordingStorage: new DiskRecordingStorage({ dir: './recordings' }), // optional
});

const app = express();
// Mount under a prefix so it never collides with your own routes.
app.use('/vidcall', createExpressRouter(services));

// Your existing routes stay untouched.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachWebSocketRelay(server, services); // /ws?roomId=...

server.listen(3000, () => console.log('app + vidcall on :3000'));
```

## What you get

| Route (under `/vidcall`)                              | Purpose                                                   |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `POST /auth/token`                                    | mint a room-scoped token (auth mode)                      |
| `POST /rooms`                                         | create a room                                             |
| `POST /rooms/:id/join` · `POST /rooms/:id/leave`      | session roster                                            |
| `POST /rooms/:id/signal`                              | relay one envelope (offer/answer/ice/...)                 |
| `POST /rooms/:id/close` · `DELETE /rooms/:id`         | close / delete a room (admin only)                        |
| `GET /rooms/:id/state` · `GET /rooms/:id/recordings`  | snapshots                                                 |
| `POST /recordings/:sessionId/chunks` · `.../finalize` | recording bytes                                           |
| `WS /ws?roomId=...&token=...`                         | live envelope relay (clients join with a `join` envelope) |

Errors are `{ "error": { "code", "message" } }` with stable codes — map them to
your UI copy. The router adds `express.json()` only to JSON routes and
`express.raw()` only to the chunk-upload route, so your app's body parsing is
unaffected.

## Auth

Enable token auth by passing `auth` to `createServices`:

```ts
const services = createServices({
  store,
  auth: {
    secret: process.env.VIDCALL_SECRET!, // HMAC signing key
    adminToken: process.env.VIDCALL_ADMIN_TOKEN!, // guards POST /auth/token
  },
});
```

With a secret set, `POST /rooms/:id/join`, `.../leave`, `.../signal`,
`GET .../state`, `.../recordings`, the recording byte routes, and the
admin-only `POST /rooms/:id/close` / `DELETE /rooms/:id` require
`Authorization: Bearer <token>`; the WS relay requires `?token=<token>`
(see the package README's "Authentication & tokens" section). Without `auth`
the server stays in legacy open mode (dev-only).

Mint tokens for your logged-in users from your Express routes — the token
endpoint is guarded by the `adminToken` header, so only your backend can call
it:

```ts
// routes/tokens.ts
import { Router, json as expressJson } from 'express';
import { createServices } from '@vidcall/server';

export function tokenRouter(services: ReturnType<typeof createServices>) {
  const router = Router();
  router.post('/vidcall-token', expressJson(), async (req, res) => {
    // 1. authorize in YOUR app: is req.user allowed in req.body.roomId?
    if (!req.user || !(await req.user.mayJoin(req.body.roomId))) {
      return res.status(403).json({ error: { code: 'forbidden' } });
    }
    // 2. mint a room-scoped participant token via the token endpoint
    const tokenRes = await fetch(`http://127.0.0.1:${VIDCALL_PORT}/auth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        adminToken: process.env.VIDCALL_ADMIN_TOKEN!,
      },
      body: JSON.stringify({
        roomId: req.body.roomId,
        participantId: req.user.id,
      }),
    });
    res.status(tokenRes.status).json(await tokenRes.json()); // { token, ... }
  });
  return router;
}
```

The client then joins with `Authorization: Bearer <token>` (REST) or
`/ws?roomId=<id>&token=<token>` (WS). You can still layer your own session
middleware on top — the token guards are room-scoped and identity-bound, they
do not replace your app's login:

```ts
app.use('/vidcall/rooms', requireLogin); // your express middleware
app.use('/vidcall', createExpressRouter(services));
```
