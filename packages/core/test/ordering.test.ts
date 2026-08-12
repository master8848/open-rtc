import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderedMessageBuffer } from '../src/ordering.ts';
import { makeEnvelope } from '../../test-utils/src/fixtures.ts';

test('OrderedMessageBuffer: accepts increasing seq, drops duplicates and stale', () => {
  const buffer = new OrderedMessageBuffer();
  const session = 'sess-1';
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'x', sessionId: session, seq: 1 })),
    true,
  );
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'x', sessionId: session, seq: 2 })),
    true,
  );
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'x', sessionId: session, seq: 2 })),
    false,
  ); // duplicate
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'x', sessionId: session, seq: 1 })),
    false,
  ); // stale
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'x', sessionId: session, seq: 5 })),
    true,
  ); // jump ahead ok
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'x', sessionId: session, seq: 3 })),
    false,
  ); // still stale
});

test('OrderedMessageBuffer: per-session isolation and reset on new session', () => {
  const buffer = new OrderedMessageBuffer();
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'a', sessionId: 's1', seq: 10 })),
    true,
  );
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'b', sessionId: 's2', seq: 1 })),
    true,
  );
  // A fresh join session resets the window.
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'a', sessionId: 's3', seq: 0 })),
    true,
  );
  buffer.reset('s1');
  assert.equal(
    buffer.accept(makeEnvelope({ type: 'chat', senderId: 'a', sessionId: 's1', seq: 0 })),
    true,
  );
});

test('OrderedMessageBuffer: tracks last seq per session', () => {
  const buffer = new OrderedMessageBuffer();
  const env = makeEnvelope({ type: 'chat', senderId: 'x', sessionId: 's', seq: 42 });
  buffer.accept(env);
  assert.equal(buffer.lastSeqFor('s'), 42);
  assert.equal(buffer.lastSeqFor('other'), undefined);
});
