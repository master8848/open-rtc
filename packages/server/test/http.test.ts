import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createNodeServer } from '../src/http.ts';
import { createServices } from '../src/services.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';
import { DiskRecordingStorage } from '../src/recording.ts';
import { startRecording, createRoom, joinRoom } from '../src/core.ts';
import { issueToken } from '../src/auth.ts';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

/** Boot a server on an ephemeral port, run fn(baseUrl), always close. */
async function withServer(
  services: ReturnType<typeof createServices>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createNodeServer(services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('http: full REST flow (create/join/state/signal/recordings)', async () => {
  const store = new InMemoryStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-rec-'));
  const services = createServices({ store, recordingStorage: new DiskRecordingStorage({ dir }) });

  await withServer(services, async (base) => {
    // create
    const created = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'demo', maxParticipants: 4, metadata: { topic: 'standup' } }),
    });
    assert.equal(created.status, 201);
    const { room } = (await created.json()) as { room: { roomId: string; state: string } };
    assert.equal(room.roomId, 'demo');
    assert.equal(room.state, 'open');

    // duplicate create → 409
    const dup = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'demo' }),
    });
    assert.equal(dup.status, 409);
    assert.equal(
      ((await dup.json()) as { error: { code: string } }).error.code,
      'room_already_exists',
    );

    // join two participants
    const joinA = await fetch(`${base}/rooms/demo/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'alice', sessionId: 's-a', displayName: 'Alice' }),
    });
    assert.equal(joinA.status, 200);
    const joinB = await fetch(`${base}/rooms/demo/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant: { participantId: 'bob', sessionId: 's-b' } }),
    });
    const joinBJson = (await joinB.json()) as { participants: { participantId: string }[] };
    assert.deepEqual(
      joinBJson.participants.map((p) => p.participantId),
      ['alice', 'bob'],
    );

    // signal relay: offer from alice → relayedTo excludes alice
    const signal = await fetch(`${base}/rooms/demo/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        type: 'offer',
        roomId: 'demo',
        senderId: 'alice',
        sessionId: 's-a',
        ts: Date.now(),
        seq: 1,
        payload: { sdp: 'v=0\r\n' },
      }),
    });
    assert.equal(signal.status, 200);
    const signalJson = (await signal.json()) as { seq: number; relayedTo: string[] };
    assert.ok(signalJson.seq >= 1);
    assert.deepEqual(signalJson.relayedTo, ['bob']);

    // state
    const state = await fetch(`${base}/rooms/demo/state`);
    assert.equal(state.status, 200);
    const stateJson = (await state.json()) as {
      room: { roomId: string };
      participants: unknown[];
      signalCount: number;
    };
    assert.equal(stateJson.room.roomId, 'demo');
    assert.equal(stateJson.participants.length, 2);
    assert.ok(stateJson.signalCount >= 1);

    // leave
    const leave = await fetch(`${base}/rooms/demo/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'alice' }),
    });
    assert.equal(leave.status, 200);
    const leaveJson = (await leave.json()) as { participants: { participantId: string }[] };
    assert.deepEqual(
      leaveJson.participants.map((p) => p.participantId),
      ['bob'],
    );

    // recordings: empty list
    const recordings = await fetch(`${base}/rooms/demo/recordings`);
    assert.equal(recordings.status, 200);
    assert.deepEqual((await recordings.json()) as { recordings: unknown[] }, { recordings: [] });

    // recording session + chunk upload + finalize
    const rec = await startRecording(store, 'demo', { metadata: { mime: 'video/webm' } });
    const chunk = Buffer.from('webm-chunk-1');
    const upload = await fetch(`${base}/recordings/${rec.sessionId}/chunks?index=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk,
    });
    assert.equal(upload.status, 201);
    assert.deepEqual((await upload.json()) as { sessionId: string; index: number; bytes: number }, {
      sessionId: rec.sessionId,
      index: 0,
      bytes: chunk.length,
    });
    const finalize = await fetch(`${base}/recordings/${rec.sessionId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(finalize.status, 200);
    const finalizeJson = (await finalize.json()) as {
      recording: { status: string };
      storage: { chunks: number; bytes: number };
    };
    assert.equal(finalizeJson.recording.status, 'finalized');
    assert.deepEqual(finalizeJson.storage, { chunks: 1, bytes: chunk.length });

    // recordings list now shows the finalized session
    const after = (await (await fetch(`${base}/rooms/demo/recordings`)).json()) as {
      recordings: { status: string }[];
    };
    assert.equal(after.recordings.length, 1);
    assert.equal(after.recordings[0]!.status, 'finalized');
  });
});

test('http: error mapping (404 room, 400 bad JSON, chunk to unknown session)', async () => {
  const store = new InMemoryStore();
  const services = createServices({ store });
  await withServer(services, async (base) => {
    const missing = await fetch(`${base}/rooms/nope/state`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      'room_not_found',
    );

    const badJson = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(
      ((await badJson.json()) as { error: { code: string } }).error.code,
      'invalid_request',
    );

    const unknownRoute = await fetch(`${base}/rooms/demo/state`, { method: 'DELETE' });
    assert.equal(unknownRoute.status, 404);

    // chunk upload with no recording storage configured → 500 recording_storage_error
    await createRoom(store, { roomId: 'r' });
    const rec = await startRecording(store, 'r');
    const upload = await fetch(`${base}/recordings/${rec.sessionId}/chunks`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    assert.equal(upload.status, 500);
    assert.equal(
      ((await upload.json()) as { error: { code: string } }).error.code,
      'recording_storage_error',
    );

    // chunk upload to unknown session → 404
    const recStore = createServices({
      store: new InMemoryStore(),
      recordingStorage: new DiskRecordingStorage({
        dir: await mkdtemp(path.join(tmpdir(), 'vidcall-rec2-')),
      }),
    });
    await withServer(recStore, async (base2) => {
      const upload2 = await fetch(`${base2}/recordings/unknown/chunks`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('x'),
      });
      assert.equal(upload2.status, 404);
      assert.equal(
        ((await upload2.json()) as { error: { code: string } }).error.code,
        'recording_not_found',
      );
    });
  });
});

test('http: guarded mode — Bearer token required, wrong room forbidden', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'secure' });
  await createRoom(store, { roomId: 'other' });
  const services = createServices({ store, auth: { secret: 'http-test-secret' } });
  await withServer(services, async (base) => {
    const join = (token: string | undefined, roomId: string, participantId: string) =>
      fetch(`${base}/rooms/${roomId}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ participantId, sessionId: `s-${participantId}` }),
      });

    // no token -> 401 unauthorized
    const none = await join(undefined, 'secure', 'alice');
    assert.equal(none.status, 401);
    assert.equal(((await none.json()) as { error: { code: string } }).error.code, 'unauthorized');

    // token for another room -> 403 forbidden
    const wrongRoom = issueToken('http-test-secret', { roomId: 'other', participantId: 'alice' });
    const forbidden = await join(wrongRoom, 'secure', 'alice');
    assert.equal(forbidden.status, 403);
    assert.equal(((await forbidden.json()) as { error: { code: string } }).error.code, 'forbidden');

    // valid token -> 200
    const valid = issueToken('http-test-secret', { roomId: 'secure', participantId: 'alice' });
    const ok = await join(valid, 'secure', 'alice');
    assert.equal(ok.status, 200);
  });
});

test('http: signal from a non-member is rejected', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r' });
  await joinRoom(store, 'r', { participantId: 'alice', sessionId: 's-a' });
  const services = createServices({ store });
  await withServer(services, async (base) => {
    const res = await fetch(`${base}/rooms/r/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        type: 'chat',
        roomId: 'r',
        senderId: 'eve',
        sessionId: 's-e',
        ts: Date.now(),
        seq: 1,
        payload: { text: 'hi' },
      }),
    });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      'participant_not_found',
    );
  });
});
