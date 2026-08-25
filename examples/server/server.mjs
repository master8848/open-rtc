/**
 * vidcall server example — ~30 lines: mount @mbsks/openrtc-server inside Express.
 *
 *   npm run build        # from the repo root — builds @mbsks/openrtc-server (dist)
 *   node examples/server/server.mjs
 *   # then, in another shell:
 *   node examples/server/client.mjs
 *
 * The REST API + WebSocket relay live under /vidcall — see
 * packages/server/README.md for the full route table and error codes.
 */
import express from 'express';
import { attachWebSocketRelay, createServices, InMemoryStore } from '@mbsks/openrtc-server';
import { createExpressRouter } from '@mbsks/openrtc-server/express';

// SQL-backed stores live behind subpath exports with optional drivers, e.g.:
//   import { SqliteStore } from '@mbsks/openrtc-server/stores/sqlite';  // + npm i better-sqlite3
import { DiskRecordingStorage } from '@mbsks/openrtc-server/recording';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-'));
const store = new InMemoryStore();
const services = createServices({
  store,
  recordingStorage: new DiskRecordingStorage({ dir }), // zero-infra client mode: InMemoryStore+Disk; swap to S3RecordingStorage for prod
  recordingTtlMs: 7 * 24 * 60 * 60 * 1000,
  recordingWebhooks: {
    onRecordingFinalized: (r) => console.log('[webhook] recording.finalized', r.sessionId),
    onRecordingDeleted: (id) => console.log('[webhook] recording.deleted', id),
  },
});
// TTL cron: run periodically (example: every hour) — also set S3 lifecycle as second layer
// setInterval(() => void import('@mbsks/openrtc-server').then(m => m.expireRecordings?.(store, { onDelete: (id) => services.recordingStorage?.delete?.(id) })), 60 * 60 * 1000);
// Range download: GET /rooms/:id/recordings/:sid/stream supports Range header (see http.ts recordingStreamHandler)

const app = express();
app.use('/vidcall', createExpressRouter(services));

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log('vidcall server listening on http://localhost:3000/vidcall');
  console.log('WebSocket relay:  ws://localhost:3000/vidcall/ws?roomId=<room>');
});

// Upgrades GET /vidcall/ws?roomId=... to the envelope relay. REST mutations
// (join/leave/signal) fan out to the same connected sockets.
attachWebSocketRelay(server, services, { path: '/vidcall/ws' });
