import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope } from '@mbsks/openrtc-protocol';
import {
  buildJoinEnvelope,
  buildLeaveEnvelope,
  closeRoom,
  createRoom,
  getRecordings,
  getRoomState,
  handleSignal,
  joinRoom,
  leaveRoom,
  listParticipants,
  startRecording,
  stopRecording,
} from '../src/core.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';

function freshStore() {
  return new InMemoryStore();
}

async function roomWithMembers(roomId: string, members: string[]) {
  const store = freshStore();
  await createRoom(store, { roomId });
  for (const m of members) {
    await joinRoom(store, roomId, { participantId: m, sessionId: `s-${m}`, displayName: m });
  }
  return store;
}

test('core: createRoom generates an id when none is given', async () => {
  const store = freshStore();
  const room = await createRoom(store);
  assert.ok(room.roomId.length > 0);
  assert.equal(room.state, 'open');
});

test('core: createRoom accepts a client-chosen id and rejects duplicates', async () => {
  const store = freshStore();
  await createRoom(store, { roomId: 'demo', maxParticipants: 2, metadata: { x: 1 } });
  await assert.rejects(createRoom(store, { roomId: 'demo' }), { code: 'room_already_exists' });
});

test('core: joinRoom returns roster and enforces capacity', async () => {
  const store = freshStore();
  await createRoom(store, { roomId: 'r', maxParticipants: 1 });
  await joinRoom(store, 'r', { participantId: 'a', sessionId: 'sa' });
  await assert.rejects(joinRoom(store, 'r', { participantId: 'b', sessionId: 'sb' }), {
    code: 'room_full',
  });
});

test('core: closeRoom rejects new joins but keeps members signaling', async () => {
  const store = freshStore();
  await createRoom(store, { roomId: 'r' });
  await joinRoom(store, 'r', { participantId: 'a', sessionId: 'sa' });
  await closeRoom(store, 'r');
  await assert.rejects(joinRoom(store, 'r', { participantId: 'b', sessionId: 'sb' }), {
    code: 'room_closed',
  });
  const d = await handleSignal(
    store,
    createEnvelope('chat', {
      roomId: 'r',
      senderId: 'a',
      sessionId: 'sa',
      payload: { text: 'hi' },
    }),
  );
  assert.deepEqual(
    d.recipients.map((p) => p.participantId),
    [],
  );
});

test('core: leaveRoom removes member and relays leave to the rest', async () => {
  const store = await roomWithMembers('r', ['a', 'b', 'c']);
  const p = (await store.getParticipant('r', 'b'))!;
  const result = await leaveRoom(store, 'r', 'b', { envelope: buildLeaveEnvelope('r', p) });
  assert.deepEqual(
    result.participants.map((x) => x.participantId),
    ['a', 'c'],
  );
  assert.deepEqual(
    result.delivery!.recipients.map((x) => x.participantId),
    ['a', 'c'],
  );
});

test('core: handleSignal relays offer to the targeted member only', async () => {
  const store = await roomWithMembers('r', ['a', 'b', 'c']);
  const d = await handleSignal(
    store,
    createEnvelope('offer', {
      roomId: 'r',
      senderId: 'a',
      sessionId: 'sa',
      targetSenderId: 'c',
      payload: { sdp: 'v=0' },
    }),
  );
  assert.deepEqual(
    d.recipients.map((p) => p.participantId),
    ['c'],
  );
});

test('core: handleSignal broadcast types include the sender; peer types exclude', async () => {
  const store = await roomWithMembers('r', ['a', 'b']);
  const presence = await handleSignal(
    store,
    createEnvelope('presence', {
      roomId: 'r',
      senderId: 'a',
      sessionId: 'sa',
      payload: { state: 'online' },
    }),
  );
  assert.deepEqual(presence.recipients.map((p) => p.participantId).sort(), ['a', 'b']);

  const chat = await handleSignal(
    store,
    createEnvelope('chat', {
      roomId: 'r',
      senderId: 'a',
      sessionId: 'sa',
      payload: { text: 'yo' },
    }),
  );
  assert.deepEqual(
    chat.recipients.map((p) => p.participantId),
    ['b'],
  );
});

test('core: handleSignal assigns a monotonic seq per room (store-side)', async () => {
  const store = await roomWithMembers('r', ['a']);
  await handleSignal(
    store,
    createEnvelope('chat', { roomId: 'r', senderId: 'a', sessionId: 'sa', payload: { text: '1' } }),
  );
  await handleSignal(
    store,
    createEnvelope('chat', { roomId: 'r', senderId: 'a', sessionId: 'sa', payload: { text: '2' } }),
  );
  const log = await store.listSignals('r', 0);
  assert.equal(log.length, 2);
  assert.ok(log[0]!.seq < log[1]!.seq);
  // The persisted envelope keeps the client's fields (seq stays client-side).
  assert.equal((log[0]!.envelope.payload as { text: string }).text, '1');
});

test('core: handleSignal rejects senders who are not members', async () => {
  const store = await roomWithMembers('r', ['a']);
  await assert.rejects(
    handleSignal(
      store,
      createEnvelope('chat', {
        roomId: 'r',
        senderId: 'eve',
        sessionId: 'se',
        payload: { text: 'x' },
      }),
    ),
    { code: 'participant_not_found' },
  );
});

test('core: getRoomState / listParticipants / listSignals', async () => {
  const store = await roomWithMembers('r', ['a', 'b']);
  const state = await getRoomState(store, 'r');
  assert.equal(state.participants.length, 2);
  assert.equal(state.room.roomId, 'r');
  assert.equal((await listParticipants(store, 'r')).length, 2);
  assert.equal((await store.listSignals('r', 0)).length, 0); // no signals yet
  await assert.rejects(listParticipants(store, 'nope'), { code: 'room_not_found' });
});

test('core: recording session lifecycle', async () => {
  const store = await roomWithMembers('r', ['a']);
  const rec = await startRecording(store, 'r', { metadata: { mime: 'video/webm' } });
  assert.equal(rec.status, 'recording');
  const stopped = await stopRecording(store, rec.sessionId);
  assert.equal(stopped.status, 'finalized');
  assert.ok(stopped.stoppedAt! >= stopped.startedAt);
  const list = await getRecordings(store, 'r');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.sessionId, rec.sessionId);
  await assert.rejects(stopRecording(store, 'missing'), { code: 'recording_not_found' });
});

test('core: buildJoinEnvelope / buildLeaveEnvelope shapes', () => {
  const j = buildJoinEnvelope('r', { participantId: 'a', sessionId: 'sa', displayName: 'Alice' });
  assert.equal(j.type, 'join');
  assert.equal(j.roomId, 'r');
  assert.equal(j.senderId, 'a');
  assert.equal(j.sessionId, 'sa');
  assert.equal((j.payload as { displayName?: string }).displayName, 'Alice');
  const l = buildLeaveEnvelope(
    'r',
    { roomId: 'r', participantId: 'a', sessionId: 'sa', joinedAt: 0, lastSeenAt: 0 },
    'bye',
  );
  assert.equal(l.type, 'leave');
  assert.equal((l.payload as { reason?: string }).reason, 'bye');
});
