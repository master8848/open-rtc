/**
 * SHARED store test suite.
 *
 * Every `Store` implementation must pass this exact matrix — the same
 * idea as the client's shared adapter suite
 * (`@vidcall/transport/shared-tests`). Run it from each store's test file:
 *
 * ```ts
 * import { runStoreTestSuite } from '@vidcall/server/shared-tests';
 * runStoreTestSuite({
 *   name: 'sqlite',
 *   createStore: async () => { const s = new SqliteStore(new Database(':memory:')); await s.bootstrap(); return s; },
 * });
 * ```
 */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope } from '@vidcall/protocol';
import {
  closeRoom,
  createRoom,
  getRoomState,
  handleSignal,
  joinRoom,
  leaveRoom,
  startRecording,
  stopRecording,
} from './core.js';
import type { Store } from './store.js';
import type { ParticipantInput } from './core.js';

export interface StoreHarness {
  /** Store name (describe title). */
  name: string;
  /** Fresh, empty store per test. */
  createStore(): Promise<Store>;
  /** Tear down (close pools, delete temp dirs, ...). */
  destroyStore?(store: Store): Promise<void>;
  /** Unique-room-id prefix to avoid cross-run collisions. Default 'shared'. */
  roomPrefix?: string;
}

let suiteCounter = 0;

export function runStoreTestSuite(h: StoreHarness): void {
  describe(`@vidcall/server shared store suite → ${h.name}`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await h.createStore();
    });
    afterEach(async () => {
      await h.destroyStore?.(store);
    });

    function roomId(): string {
      return `${h.roomPrefix ?? 'shared'}-${h.name}-r${++suiteCounter}`;
    }

    function participant(id: string): ParticipantInput {
      return { participantId: id, sessionId: `session-${id}`, displayName: `User ${id}` };
    }

    it('creates a room and reads it back with metadata intact', async () => {
      const id = roomId();
      const room = await createRoom(store, {
        roomId: id,
        maxParticipants: 4,
        metadata: { topic: 'standup', nested: { a: [1, 2, 3] } },
      });
      const fetched = await store.getRoom(id);
      assert.ok(fetched);
      assert.equal(fetched.roomId, id);
      assert.equal(fetched.state, 'open');
      assert.equal(fetched.maxParticipants, 4);
      assert.deepEqual(fetched.metadata, { topic: 'standup', nested: { a: [1, 2, 3] } });
      assert.equal(room.createdAt, fetched.createdAt);
    });

    it('rejects a duplicate room id', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await assert.rejects(createRoom(store, { roomId: id }), (err: unknown) =>
        (err as { code?: string }).code === 'room_already_exists');
    });

    it('join adds a participant and listParticipants reflects the roster', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      const a = await joinRoom(store, id, participant('alice'));
      const b = await joinRoom(store, id, participant('bob'));
      assert.equal(a.participants.length, 1);
      assert.equal(b.participants.length, 2);
      const roster = await store.listParticipants(id);
      assert.deepEqual(roster.map((p) => p.participantId), ['alice', 'bob']);
      const alice = await store.getParticipant(id, 'alice');
      assert.equal(alice?.displayName, 'User alice');
      assert.equal(alice?.sessionId, 'session-alice');
      assert.equal(alice?.joinedAt, a.participant.joinedAt);
    });

    it('join on an unknown room fails with room_not_found', async () => {
      await assert.rejects(joinRoom(store, roomId(), participant('alice')), (err: unknown) =>
        (err as { code?: string }).code === 'room_not_found');
    });

    it('double-join of the same participant fails unless upsert', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      await assert.rejects(joinRoom(store, id, participant('alice')), (err: unknown) =>
        (err as { code?: string }).code === 'participant_already_joined');
      const result = await joinRoom(store, id, participant('alice'), { upsert: true });
      assert.equal(result.participants.length, 1);
    });

    it('enforces maxParticipants', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id, maxParticipants: 1 });
      await joinRoom(store, id, participant('alice'));
      await assert.rejects(joinRoom(store, id, participant('bob')), (err: unknown) =>
        (err as { code?: string }).code === 'room_full');
    });

    it('closeRoom rejects joins but keeps existing members signaling', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      const closed = await closeRoom(store, id);
      assert.equal(closed.state, 'closed');
      await assert.rejects(joinRoom(store, id, participant('bob')), (err: unknown) =>
        (err as { code?: string }).code === 'room_closed');
      const delivery = await handleSignal(
        store,
        createEnvelope('chat', {
          roomId: id,
          senderId: 'alice',
          sessionId: 'session-alice',
          payload: { text: 'still here' },
        }),
      );
      assert.equal(delivery.recipients.length, 0); // alice is the only member
    });

    it('leave removes the participant and leaves are idempotent-safe (second leave errors)', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      await joinRoom(store, id, participant('bob'));
      const result = await leaveRoom(store, id, 'alice');
      assert.deepEqual(result.participants.map((p) => p.participantId), ['bob']);
      assert.equal(await store.getParticipant(id, 'alice'), null);
      await assert.rejects(leaveRoom(store, id, 'alice'), (err: unknown) =>
        (err as { code?: string }).code === 'participant_not_found');
    });

    it('putSignal assigns strictly increasing per-room seq; listSignals(since) filters', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      const s1 = await store.putSignal({
        roomId: id,
        envelope: createEnvelope('chat', { roomId: id, senderId: 'alice', sessionId: 's', payload: { text: 'one' } }),
        receivedAt: 1,
      });
      const s2 = await store.putSignal({
        roomId: id,
        envelope: createEnvelope('chat', { roomId: id, senderId: 'alice', sessionId: 's', payload: { text: 'two' } }),
        receivedAt: 2,
      });
      const s3 = await store.putSignal({
        roomId: id,
        envelope: createEnvelope('chat', { roomId: id, senderId: 'alice', sessionId: 's', payload: { text: 'three' } }),
        receivedAt: 3,
      });
      assert.ok(s1.seq < s2.seq && s2.seq < s3.seq);
      const after = await store.listSignals(id, s2.seq);
      assert.deepEqual(after.map((s) => s.seq), [s3.seq]);
      const all = await store.listSignals(id, 0);
      assert.equal(all.length, 3);
      // Envelope JSON round-trips verbatim through the store.
      assert.deepEqual(all[1]!.envelope, s2.envelope);
    });

    it('handles relay recipient rules: offer excludes sender, presence includes everyone', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      await joinRoom(store, id, participant('bob'));
      await joinRoom(store, id, participant('carol'));

      const offer = await handleSignal(
        store,
        createEnvelope('offer', {
          roomId: id,
          senderId: 'alice',
          sessionId: 'session-alice',
          targetSenderId: 'carol',
          payload: { sdp: 'v=0\r\n' },
        }),
      );
      assert.deepEqual(offer.recipients.map((p) => p.participantId), ['carol']);

      const broadcast = await handleSignal(
        store,
        createEnvelope('presence', {
          roomId: id,
          senderId: 'bob',
          sessionId: 'session-bob',
          payload: { state: 'online' },
        }),
      );
      assert.deepEqual(broadcast.recipients.map((p) => p.participantId).sort(), ['alice', 'bob', 'carol']);
    });

    it('rejects signals from participants who are not in the room', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      await assert.rejects(
        handleSignal(
          store,
          createEnvelope('chat', { roomId: id, senderId: 'eve', sessionId: 'session-eve', payload: { text: 'hi' } }),
        ),
        (err: unknown) => (err as { code?: string }).code === 'participant_not_found',
      );
    });

    it('rejects malformed envelopes', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await assert.rejects(handleSignal(store, { not: 'an envelope' }), (err: unknown) =>
        (err as { code?: string }).code === 'invalid_envelope');
    });

    it('touches lastSeenAt on activity', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      const { participant: alice } = await joinRoom(store, id, participant('alice'));
      await handleSignal(
        store,
        createEnvelope('reaction', { roomId: id, senderId: 'alice', sessionId: 'session-alice', payload: { emoji: '👋' } }),
      );
      const updated = await store.getParticipant(id, 'alice');
      assert.ok(updated!.lastSeenAt >= alice.lastSeenAt);
    });

    it('recording sessions round-trip through the store', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      const rec = await startRecording(store, id, { metadata: { mime: 'video/webm' } });
      assert.equal(rec.status, 'recording');
      assert.equal(rec.roomId, id);
      const list = await store.listRecordings(id);
      assert.equal(list.length, 1);
      assert.deepEqual(list[0]!.metadata, { mime: 'video/webm' });
      const fetched = await store.getRecording(rec.sessionId);
      assert.equal(fetched?.sessionId, rec.sessionId);
      const stopped = await stopRecording(store, rec.sessionId);
      assert.equal(stopped.status, 'finalized');
      assert.ok(stopped.stoppedAt! >= stopped.startedAt);
      const byId = await store.getRecording(rec.sessionId);
      assert.equal(byId?.status, 'finalized');
      await assert.rejects(stopRecording(store, 'missing'), (err: unknown) =>
        (err as { code?: string }).code === 'recording_not_found');
    });

    it('getRoomState returns room + roster + signal count', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      await handleSignal(
        store,
        createEnvelope('chat', { roomId: id, senderId: 'alice', sessionId: 'session-alice', payload: { text: 'x' } }),
      );
      const state = await getRoomState(store, id);
      assert.equal(state.room.roomId, id);
      assert.equal(state.participants.length, 1);
      assert.ok(state.signalCount >= 1);
    });

    it('deleteRoom clears participants, signals and recordings (when supported)', async () => {
      const id = roomId();
      await createRoom(store, { roomId: id });
      await joinRoom(store, id, participant('alice'));
      const rec = await startRecording(store, id);
      await store.putSignal({
        roomId: id,
        envelope: createEnvelope('chat', { roomId: id, senderId: 'alice', sessionId: 'session-alice', payload: { text: 'x' } }),
        receivedAt: 1,
      });
      if (!store.deleteRoom) return;
      await store.deleteRoom(id);
      assert.equal(await store.getRoom(id), null);
      assert.equal((await store.listParticipants(id)).length, 0);
      assert.equal((await store.listSignals(id, 0)).length, 0);
      assert.equal((await store.listRecordings(id)).length, 0);
      assert.equal(await store.getRecording(rec.sessionId), null);
    });
  });
}
