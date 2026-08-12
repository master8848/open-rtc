import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createExpressRouter } from '../src/express.ts';
import { createServices } from '../src/services.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';
import { DiskRecordingStorage } from '../src/recording.ts';
import { startRecording, createRoom } from '../src/core.ts';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

async function withExpressApp(fn: (base: string) => Promise<void>): Promise<void> {
  const store = new InMemoryStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-expr-'));
  const app = express();
  app.use('/vidcall', createExpressRouter(createServices({ store, recordingStorage: new DiskRecordingStorage({ dir }) })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/vidcall`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('express: router mounts and serves the REST API under a prefix', async () => {
  const store = new InMemoryStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-expr-'));
  const app = express();
  app.use('/vidcall', createExpressRouter(createServices({ store, recordingStorage: new DiskRecordingStorage({ dir }) })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/vidcall`;
  try {
    const created = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'expr-room', metadata: { origin: 'express' } }),
    });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { room: { roomId: string } }).room.roomId, 'expr-room');

    const join = await fetch(`${base}/rooms/expr-room/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'alice', sessionId: 's-a' }),
    });
    assert.equal(join.status, 200);

    const state = await fetch(`${base}/rooms/expr-room/state`);
    assert.equal(state.status, 200);
    const stateJson = (await state.json()) as { participants: unknown[] };
    assert.equal(stateJson.participants.length, 1);

    // 404 for unknown room through the mounted router
    const missing = await fetch(`${base}/rooms/nope/state`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('express: recording chunk upload + finalize through the router', async () => {
  const store = new InMemoryStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-expr2-'));
  const app = express();
  app.use('/vidcall', createExpressRouter(createServices({ store, recordingStorage: new DiskRecordingStorage({ dir }) })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/vidcall`;
  try {
    await createRoom(store, { roomId: 'r' });
    const rec = await startRecording(store, 'r');
    const upload = await fetch(`${base}/recordings/${rec.sessionId}/chunks`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('webm-bytes'),
    });
    assert.equal(upload.status, 201);
    const finalize = await fetch(`${base}/recordings/${rec.sessionId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(finalize.status, 200);
    assert.equal(((await finalize.json()) as { recording: { status: string } }).recording.status, 'finalized');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
