# Hosting @vidcall/server in a Fastify app

Register the component as a plugin — Fastify's lifecycle, logging, and
`reply` helpers apply to the mounted routes. The WS relay attaches to the
Fastify HTTP server.

```bash
npm install @vidcall/server fastify
```

```ts
// server.ts
import Fastify from 'fastify';
import {
  attachWebSocketRelay,
  createFastifyPlugin,
  createServices,
  PostgresStore,
  S3RecordingStorage,
} from '@vidcall/server';

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
| `POST /rooms`                                         | create a room      |
| `POST /rooms/:id/join` · `POST /rooms/:id/leave`      | session roster     |
| `POST /rooms/:id/signal`                              | relay one envelope |
| `GET /rooms/:id/state` · `GET /rooms/:id/recordings`  | snapshots          |
| `POST /recordings/:sessionId/chunks` · `.../finalize` | recording bytes    |
| `WS /ws?roomId=...`                                   | live relay         |

The plugin registers an `application/octet-stream` content-type parser (raw
buffer) so chunk uploads bypass JSON parsing; every other route uses Fastify's
default JSON parser.

## Auth

Wrap the plugin with Fastify hooks:

```ts
await app.register(async (scoped) => {
  scoped.addHook('preHandler', async (req, reply) => {
    const ok = await req.session?.authorizeRoom(req.params?.id);
    if (!ok) return reply.code(401).send({ error: { code: 'unauthorized' } });
  });
  await scoped.register(createFastifyPlugin(services));
});
```
