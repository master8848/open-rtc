# Hosting @vidcall/server in an Express app

Mount the component's router directly inside your existing Express app — no
separate process, no proxy. The WS relay upgrades the same HTTP server, so
`/ws?roomId=...` and the REST API share one port.

```bash
npm install @vidcall/server express
```

```ts
// server.ts
import express from 'express';
import http from 'node:http';
import {
  attachWebSocketRelay,
  createExpressRouter,
  createServices,
  SqliteStore,
  DiskRecordingStorage,
} from '@vidcall/server';
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
| `POST /rooms`                                         | create a room                                             |
| `POST /rooms/:id/join` · `POST /rooms/:id/leave`      | session roster                                            |
| `POST /rooms/:id/signal`                              | relay one envelope (offer/answer/ice/...)                 |
| `GET /rooms/:id/state` · `GET /rooms/:id/recordings`  | snapshots                                                 |
| `POST /recordings/:sessionId/chunks` · `.../finalize` | recording bytes                                           |
| `WS /ws?roomId=...`                                   | live envelope relay (clients join with a `join` envelope) |

Errors are `{ "error": { "code", "message" } }` with stable codes — map them to
your UI copy. The router adds `express.json()` only to JSON routes and
`express.raw()` only to the chunk-upload route, so your app's body parsing is
unaffected.

## Auth

Guard the router with your normal Express middleware: require a session for
`/vidcall/rooms`, and only let a participant join rooms they are invited to:

```ts
app.use('/vidcall/rooms', requireAuth); // any express middleware
app.use('/vidcall', createExpressRouter(services));
```

For WS auth, validate the connection in an `upgrade` handler before calling
`attachWebSocketRelay` (or wrap it: reject upgrades without a valid
`?token=` that your middleware minted).
