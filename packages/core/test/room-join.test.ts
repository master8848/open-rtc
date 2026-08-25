import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { resetFakeRTC } from '../../test-utils/src/index.ts';
import { sleep, waitFor } from '../../test-utils/src/fixtures.ts';

beforeEach(() => resetFakeRTC());

/** Transport whose `join` can be held open to simulate a slow backend. */
class GatedTransport extends InMemoryTransport {
  gate: Promise<void> = Promise.resolve();
  messageSubscriptions = 0;
  releaseGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  override async join(
    roomId: string,
    self: Parameters<InMemoryTransport['join']>[1],
  ): Promise<void> {
    await this.gate;
    return super.join(roomId, self);
  }

  override onMessage(callback: Parameters<InMemoryTransport['onMessage']>[0]): () => void {
    this.messageSubscriptions++;
    return super.onMessage(callback);
  }
}

test('join: rejects immediately when the signal is already aborted', async () => {
  const transport = new GatedTransport();
  const room = new Room({ roomId: 'r', selfId: 'a', transport });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(room.join({ signal: controller.signal }), /abort/i);
  assert.equal(room.isJoined, false);
  assert.equal(room.getSnapshot().status, 'new');

  // The room stays retryable.
  await room.join();
  assert.equal(room.isJoined, true);
  await room.leave();
});

test('join: aborting mid-flight rolls back subscriptions and releases the transport', async () => {
  const transport = new GatedTransport();
  const room = new Room({ roomId: 'r', selfId: 'a', transport });
  transport.hold();

  const controller = new AbortController();
  const joining = room.join({ signal: controller.signal });
  controller.abort(); // while transport.join() is still pending
  transport.releaseGate!();

  await assert.rejects(joining, /abort/i);
  await sleep(5); // let rollback settle

  assert.equal(room.isJoined, false);
  assert.equal(room.getSnapshot().status, 'new');
  assert.equal(transport.messageSubscriptions, 0, 'no subscriptions leaked');
  assert.equal(transport.roomId, null, 'transport session released');

  // Retry joins cleanly.
  await room.join();
  assert.equal(room.isJoined, true);
  assert.equal(transport.messageSubscriptions, 1);
  await room.leave();
});

test('join: concurrent joins are serialized (StrictMode double-mount shape)', async () => {
  const transport = new GatedTransport();
  const room = new Room({ roomId: 'r', selfId: 'a', transport });
  transport.hold();

  // Mount #1 starts a join; cleanup aborts it; mount #2 joins again — all
  // before the first join's first step resolved.
  const controller1 = new AbortController();
  const join1 = room.join({ signal: controller1.signal });
  const controller2 = new AbortController();
  const join2 = room.join({ signal: controller2.signal });

  controller1.abort();
  transport.releaseGate!();

  await assert.rejects(join1, /abort/i);
  const joined = await join2; // waits for join1 to settle, then succeeds
  assert.equal(joined, room);
  assert.equal(room.isJoined, true);

  // Exactly one live set of transport subscriptions.
  assert.equal(transport.messageSubscriptions, 1);
  assert.ok(transport.roomId === 'r');
  await waitFor(() => room.getSnapshot().status === 'joined');
  await room.leave();
});

test('join: status transitions surface in the snapshot', async () => {
  const transport = new GatedTransport();
  const room = new Room({ roomId: 'r', selfId: 'a', transport });
  transport.hold();

  const statuses: string[] = [room.getSnapshot().status];
  room.subscribe(() => {
    const status = room.getSnapshot().status;
    if (statuses[statuses.length - 1] !== status) statuses.push(status);
  });

  const joining = room.join();
  await sleep(5); // runJoin marked itself as joining
  transport.releaseGate!();
  await joining;

  assert.deepEqual(statuses, ['new', 'joining', 'joined']);
  await room.leave();
});

test('join: second call after success resolves to the same joined room', async () => {
  const room = new Room({ roomId: 'r', selfId: 'a', transport: new GatedTransport() });
  const first = await room.join();
  const second = await room.join({ signal: new AbortController().signal });
  assert.equal(second, first);
  assert.equal(room.isJoined, true);
  await room.leave();
});
