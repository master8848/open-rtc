import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '../src/transport.ts';
import { makeEnvelope, sleep } from '../../test-utils/src/fixtures.ts';
import type { ParticipantPresence } from '../src/transport.ts';

test('InMemoryTransport: join + broadcast to others, not self', async () => {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  await a.join('room-1', { id: 'a' });
  await b.join('room-1', { id: 'b' });

  const receivedByB: string[] = [];
  b.onMessage((env) => receivedByB.push(env.type));
  let receivedByA = 0;
  a.onMessage(() => receivedByA++);

  await a.emit(makeEnvelope({ type: 'chat', senderId: 'a', roomId: 'room-1' }));
  await sleep(5);
  assert.deepEqual(receivedByB, ['chat']);
  assert.equal(receivedByA, 0); // no echo
});

test('InMemoryTransport: targetSenderId unicast', async () => {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  const c = new InMemoryTransport();
  await a.join('room-1', { id: 'a' });
  await b.join('room-1', { id: 'b' });
  await c.join('room-1', { id: 'c' });

  const gotB: string[] = [];
  const gotC: string[] = [];
  b.onMessage((env) => gotB.push(env.type));
  c.onMessage((env) => gotC.push(env.type));

  await a.emit(
    makeEnvelope({ type: 'offer', senderId: 'a', roomId: 'room-1', targetSenderId: 'b' }),
  );
  await sleep(5);
  assert.deepEqual(gotB, ['offer']);
  assert.deepEqual(gotC, []);
});

test('InMemoryTransport: presence broadcast', async () => {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  await a.join('room-1', { id: 'a' });
  await b.join('room-1', { id: 'b' });

  const presences: ParticipantPresence[] = [];
  b.onPresence((p) => presences.push(p));
  await a.setPresence('away', { note: 'brb' });
  await sleep(5);
  assert.equal(presences.length, 1);
  assert.equal(presences[0]!.participantId, 'a');
  assert.equal(presences[0]!.state, 'away');
  assert.deepEqual(presences[0]!.metadata, { note: 'brb' });
});

test('InMemoryTransport: leave removes from room; dispose is idempotent', async () => {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  await a.join('room-1', { id: 'a' });
  await b.join('room-1', { id: 'b' });

  await a.leave();
  const received: string[] = [];
  b.onMessage((env) => received.push(env.type));
  await a.emit(makeEnvelope({ type: 'chat', senderId: 'a', roomId: 'room-1' }));
  await sleep(5);
  assert.deepEqual(received, []);

  await a.dispose();
  await a.dispose(); // idempotent
  await assert.rejects(
    () => a.emit(makeEnvelope({ type: 'chat', senderId: 'a', roomId: 'room-1' })),
    /disposed|not in a room/,
  );
});

test('InMemoryTransport: echo option delivers back to sender', async () => {
  const a = new InMemoryTransport({ echo: true });
  const b = new InMemoryTransport();
  await a.join('room-1', { id: 'a' });
  await b.join('room-1', { id: 'b' });
  let selfEchoes = 0;
  a.onMessage(() => selfEchoes++);
  await a.emit(makeEnvelope({ type: 'ping', senderId: 'a', roomId: 'room-1' }));
  await sleep(5);
  assert.equal(selfEchoes, 1);
});
