import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createFastifyPlugin } from '../src/fastify.ts';
import { createServices } from '../src/services.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';
import { DiskRecordingStorage } from '../src/recording.ts';
import { startRecording, createRoom } from '../src/core.ts';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

async function withFastifyApp(fn: (base: string) => Promise<void>): Promise<void> {
  const store = new InMemoryStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-fastify-'));
  const app = Fastify();
  await app.register(
    createFastifyPlugin(
      createServices({ store, recordingStorage: new DiskRecordingStorage({ dir }) }),
    ),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await app.close();
  }
}

test('fastify: plugin serves the REST API', async () => {
  await withFastifyApp(async (base) => {
    const created = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'fast-room', maxParticipants: 3 }),
    });
    assert.equal(created.status, 201);
    assert.equal(
      ((await created.json()) as { room: { maxParticipants?: number } }).room.maxParticipants,
      3,
    );

    const join = await fetch(`${base}/rooms/fast-room/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'alice', sessionId: 's-a' }),
    });
    assert.equal(join.status, 200);

    const state = await fetch(`${base}/rooms/fast-room/state`);
    assert.equal(state.status, 200);
    const stateJson = (await state.json()) as { participants: unknown[] };
    assert.equal(stateJson.participants.length, 1);

    // unknown room → 404 with the vidcall error shape
    const missing = await fetch(`${base}/rooms/nope/state`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      'room_not_found',
    );
  });
});

test('fastify: recording chunk upload + finalize', async () => {
  const store = new InMemoryStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-fastify2-'));
  const app = Fastify();
  await app.register(
    createFastifyPlugin(
      createServices({ store, recordingStorage: new DiskRecordingStorage({ dir }) }),
    ),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await createRoom(store, { roomId: 'r' });
    const rec = await startRecording(store, 'r');
    const upload = await fetch(`${base}/recordings/${rec.sessionId}/chunks`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('webm-bytes-2'),
    });
    assert.equal(upload.status, 201);
    const finalize = await fetch(`${base}/recordings/${rec.sessionId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(finalize.status, 200);
    assert.equal(
      ((await finalize.json()) as { recording: { status: string } }).recording.status,
      'finalized',
    );
  } finally {
    await app.close();
  }
});
