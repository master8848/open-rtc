# Hosting @mbsks/server in a Fastify app

Register the component as a plugin — Fastify's lifecycle, logging, and
`reply` helpers apply to the mounted routes. The WS relay attaches to the
Fastify HTTP server.

```bash
npm install @mbsks/server fastify pg
```

```ts
// server.ts
import Fastify from 'fastify';
import { attachWebSocketRelay, createServices, S3RecordingStorage } from '@mbsks/server';
import { createFastifyPlugin } from '@mbsks/server/fastify';
import { PostgresStore } from '@mbsks/server/stores/postgres';

const store = new PostgresStore(process.env.DATABASE_URL!);
await store.bootstrap();

const services = createServices({
  store,
  recordingStorage: new S3RecordingStorage({
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
    forcePathStyle: true, // MinIO / R2 / localstack
  }),
});

const app = Fastify({ logger: true });
await app.register(createFastifyPlugin(services));

// Your existing routes stay untouched.
app.get('/healthz', async () => ({ ok: true }));

await app.listen({ port: 3000 });
// WS relay on the same server:
attachWebSocketRelay(app.server, services);
```

## What you get

| Route                                                 | Purpose            |
| ----------------------------------------------------- | ------------------ |
| `POST /auth/token`                                    | mint room tokens   |
| `POST /rooms`                                         | create a room      |
| `POST /rooms/:id/join` · `POST /rooms/:id/leave`      | session roster     |
| `POST /rooms/:id/signal`                              | relay one envelope |
| `POST /rooms/:id/close` · `DELETE /rooms/:id`         | admin room control |
| `GET /rooms/:id/state` · `GET /rooms/:id/recordings`  | snapshots          |
| `POST /recordings/:sessionId/chunks` · `.../finalize` | recording bytes    |
| `WS /ws?roomId=...&token=...`                         | live relay         |

The plugin registers an `application/octet-stream` content-type parser (raw
buffer) so chunk uploads bypass JSON parsing; every other route uses Fastify's
default JSON parser.

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

Mint tokens for your logged-in users from a Fastify route — the token
endpoint is guarded by the `adminToken` header, so only your backend can call
it:

```ts
app.post('/vidcall-token', async (req, reply) => {
  // 1. authorize in YOUR app: is req.user allowed in body.roomId?
  const { roomId } = req.body as { roomId: string };
  if (!req.user || !(await req.user.mayJoin(roomId))) {
    return reply.code(403).send({ error: { code: 'forbidden' } });
  }
  // 2. mint a room-scoped participant token via the token endpoint
  const tokenRes = await fetch(`http://127.0.0.1:${VIDCALL_PORT}/auth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      adminToken: process.env.VIDCALL_ADMIN_TOKEN!,
    },
    body: JSON.stringify({ roomId, participantId: req.user.id }),
  });
  return reply.code(tokenRes.status).send(await tokenRes.json()); // { token, ... }
});
```

The client then joins with `Authorization: Bearer <token>` (REST) or
`/ws?roomId=<id>&token=<token>` (WS). You can still wrap the plugin with
Fastify hooks for your own session checks — the token guards are room-scoped
and identity-bound, they do not replace your app's login:

```ts
await app.register(async (scoped) => {
  scoped.addHook('preHandler', async (req, reply) => {
    const ok = await req.session?.authorizeRoom(req.params?.id);
    if (!ok) return reply.code(401).send({ error: { code: 'unauthorized' } });
  });
  await scoped.register(createFastifyPlugin(services));
});
```
