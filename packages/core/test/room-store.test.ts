import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { ObservableStore, type RoomSnapshot } from '../src/store.ts';
import { FakeMediaStreamTrack, resetFakeRTC } from '../../test-utils/src/index.ts';
import { sleep, waitFor } from '../../test-utils/src/fixtures.ts';

beforeEach(() => resetFakeRTC());

function makeRoomPair(): { a: Room; b: Room; transportB: InMemoryTransport } {
  const a = new Room({ roomId: 'room-1', selfId: 'a', transport: new InMemoryTransport() });
  const transportB = new InMemoryTransport();
  const b = new Room({ roomId: 'room-1', selfId: 'b', transport: transportB });
  return { a, b, transportB };
}

async function joinBoth(a: Room, b: Room): Promise<void> {
  await a.join();
  await b.join();
  await waitFor(() => !!a.getParticipant('b') && !!b.getParticipant('a'));
}

test('ObservableStore: notifies on change, stays silent when equal', () => {
  const store = new ObservableStore<{ n: number }>({ n: 0 });
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  assert.equal(store.getSnapshot().n, 0);

  store.set({ n: 1 }); // change → notify
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().n, 1);

  store.set(store.getSnapshot()); // same reference → no notify
  assert.equal(calls, 1);
  unsubscribe();
  store.set({ n: 2 }); // unsubscribed → no notify
  assert.equal(calls, 1);
});

test('ObservableStore: a throwing listener does not stop the others', () => {
  const store = new ObservableStore<{ n: number }>({ n: 0 });
  const seen: number[] = [];
  let thrown: unknown;
  store.subscribe(() => {
    throw new Error('boom');
  });
  store.subscribe(() => seen.push(store.getSnapshot().n));
  try {
    store.set({ n: 7 });
  } catch (err) {
    thrown = err;
  }
  // The healthy listener still ran and the error surfaced afterwards.
  assert.deepEqual(seen, [7]);
  assert.match(String(thrown), /boom/);
});

test('Room: subscribe/getSnapshot notify on roster changes', async () => {
  const { a, b } = makeRoomPair();
  const updates: RoomSnapshot[] = [];
  const unsubscribe = b.subscribe(() => updates.push(b.getSnapshot()));

  assert.equal(b.getSnapshot().status, 'new');
  await joinBoth(a, b);

  await waitFor(() => b.getSnapshot().participants.some((p) => p.id === 'a'));
  assert.ok(updates.length >= 2, `expected several notifications, got ${updates.length}`);
  const latest = b.getSnapshot();
  assert.equal(latest.status, 'joined');
  assert.deepEqual(
    latest.participants.map((p) => p.id),
    ['a'],
  );
  assert.equal(latest.participants[0]!.displayName, undefined);
  assert.equal(latest.selfId, 'b');
  assert.equal(latest.roomId, 'room-1');

  // Participant records are plain immutable data, not live class instances.
  const record = latest.participants[0]!;
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.notEqual(b.getParticipant('a'), record);

  unsubscribe();
  await a.leave();
  await b.leave();
});

test('Room: snapshot is stable across unrelated updates (reactions/chat)', async () => {
  const { a, b } = makeRoomPair();
  await joinBoth(a, b);
  const before = b.getSnapshot();

  let notified = false;
  b.subscribe(() => {
    notified = true;
  });

  // Unrelated events: reactions and chat do not touch tracked state.
  await a.sendReaction('🎉');
  await a.sendChat('hello');
  await sleep(5); // let the microtasked deliveries land

  assert.equal(notified, false, 'unrelated updates must not notify subscribers');
  assert.equal(b.getSnapshot(), before, 'snapshot reference must be unchanged');
  await a.leave();
  await b.leave();
});

test('Room: duplicate connection-state events keep the same snapshot reference', async () => {
  const { a, b } = makeRoomPair();
  await joinBoth(a, b);
  const before = b.getSnapshot();

  // Re-emit the same state the roster already carries: the equality check
  // must suppress the redundant notification.
  b.emit('connection-state', {
    participantId: 'a',
    state: before.participants[0]!.connectionState,
  });

  assert.equal(b.getSnapshot(), before);
  await a.leave();
  await b.leave();
});

test('Room: unsubscribe stops notifications', async () => {
  const { a, b } = makeRoomPair();
  let calls = 0;
  const unsubscribe = b.subscribe(() => calls++);
  await a.join();
  await b.join();
  await waitFor(() => !!b.getParticipant('a'));
  const duringSubscription = calls;
  assert.ok(duringSubscription > 0);

  unsubscribe();
  const c = new Room({ roomId: 'room-1', selfId: 'c', transport: new InMemoryTransport() });
  await c.join();
  await waitFor(() => !!c.getParticipant('b'));
  assert.equal(calls, duringSubscription, 'no notifications after unsubscribe');

  // Unsubscribe is idempotent.
  unsubscribe();
  await c.leave();
  await a.leave();
  await b.leave();
});

test('Room: listener errors are isolated and reported via the error event', async () => {
  const { a, b } = makeRoomPair();
  const errors: Error[] = [];
  b.on('error', (err) => errors.push(err));
  b.subscribe(() => {
    throw new Error('listener boom');
  });
  let otherCalls = 0;
  b.subscribe(() => otherCalls++);

  await joinBoth(a, b); // emits participant-joined → notification loop

  assert.equal(otherCalls > 0, true, 'healthy listeners still run');
  await waitFor(() => errors.length > 0);
  assert.match(errors[0]!.message, /listener boom/);
  await a.leave();
  await b.leave();
});

test('Room: local publish/unpublish update the snapshot', async () => {
  const room = new Room({ roomId: 'r', selfId: 'me', transport: new InMemoryTransport() });
  const snapshots: RoomSnapshot[] = [];
  room.subscribe(() => snapshots.push(room.getSnapshot()));

  assert.deepEqual(room.getSnapshot().local.publications, []);
  const track = new FakeMediaStreamTrack('video');
  await room.publish(track);

  let pubs = room.getSnapshot().local.publications;
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0]!.kind, 'video');
  assert.equal(pubs[0]!.track, track);

  await room.unpublish(room.local.publications[0]!);
  pubs = room.getSnapshot().local.publications;
  assert.equal(pubs.length, 0);
  assert.ok(snapshots.length >= 2);
  await room.leave();
});

test('Room: lazy rebuild — mutations without subscribers are picked up later', async () => {
  const { a, b } = makeRoomPair();
  await a.join();
  await b.join();
  await waitFor(() => !!b.getParticipant('a'));

  // No subscriber ever attached; getSnapshot() must still reflect reality.
  const snapshot = b.getSnapshot();
  assert.equal(snapshot.status, 'joined');
  assert.equal(snapshot.participants.length, 1);
  // And it stays stable on repeated reads.
  assert.equal(b.getSnapshot(), snapshot);
  await a.leave();
  await b.leave();
});
