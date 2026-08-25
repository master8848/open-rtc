/**
 * vidcall server example — ~30 lines: mount @vidcall/server inside Express.
 *
 *   npm run build        # from the repo root — builds @vidcall/server (dist)
 *   node examples/server/server.mjs
 *   # then, in another shell:
 *   node examples/server/client.mjs
 *
 * The REST API + WebSocket relay live under /vidcall — see
 * packages/server/README.md for the full route table and error codes.
 */
import express from 'express';
import { attachWebSocketRelay, createServices, InMemoryStore } from '@vidcall/server';
import { createExpressRouter } from '@vidcall/server/express';

// SQL-backed stores live behind subpath exports with optional drivers, e.g.:
//   import { SqliteStore } from '@vidcall/server/stores/sqlite';  // + npm i better-sqlite3
const store = new InMemoryStore();
const services = createServices({ store }); // add recordingStorage for recordings

const app = express();
app.use('/vidcall', createExpressRouter(services));

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log('vidcall server listening on http://localhost:3000/vidcall');
  console.log('WebSocket relay:  ws://localhost:3000/vidcall/ws?roomId=<room>');
});

// Upgrades GET /vidcall/ws?roomId=... to the envelope relay. REST mutations
// (join/leave/signal) fan out to the same connected sockets.
attachWebSocketRelay(server, services, { path: '/vidcall/ws' });
