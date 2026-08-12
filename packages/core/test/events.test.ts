import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypedEmitter } from '../src/events.ts';

type Events = {
  data: [number];
  error: [Error];
  open: [];
};

test('TypedEmitter: on + emit + unsubscribe', () => {
  const emitter = new TypedEmitter<Events>();
  const seen: number[] = [];
  const off = emitter.on('data', (n) => seen.push(n));
  emitter.emit('data', 1);
  emitter.emit('data', 2);
  off();
  emitter.emit('data', 3);
  assert.deepEqual(seen, [1, 2]);
});

test('TypedEmitter: once fires a single time', () => {
  const emitter = new TypedEmitter<Events>();
  let count = 0;
  emitter.once('open', () => count++);
  emitter.emit('open');
  emitter.emit('open');
  assert.equal(count, 1);
});

test('TypedEmitter: off removes a specific listener', () => {
  const emitter = new TypedEmitter<Events>();
  const seen: number[] = [];
  const a = (n: number) => seen.push(n);
  const b = (n: number) => seen.push(n * 10);
  emitter.on('data', a);
  emitter.on('data', b);
  emitter.off('data', a);
  emitter.emit('data', 5);
  assert.deepEqual(seen, [50]);
});

test('TypedEmitter: removeAllListeners and listenerCount', () => {
  const emitter = new TypedEmitter<Events>();
  emitter.on('data', () => {});
  emitter.on('open', () => {});
  assert.equal(emitter.listenerCount('data'), 1);
  emitter.removeAllListeners('data');
  assert.equal(emitter.listenerCount('data'), 0);
  assert.equal(emitter.listenerCount('open'), 1);
  emitter.removeAllListeners();
  assert.equal(emitter.listenerCount('open'), 0);
});

test('TypedEmitter: emit returns false when no listeners', () => {
  const emitter = new TypedEmitter<Events>();
  assert.equal(emitter.emit('open'), false);
  emitter.on('open', () => {});
  assert.equal(emitter.emit('open'), true);
});

test('TypedEmitter: listeners added during emit do not run in the same pass', () => {
  const emitter = new TypedEmitter<Events>();
  const runs: string[] = [];
  const first = () => {
    runs.push('first');
    emitter.on('data', () => runs.push('second'));
  };
  emitter.on('data', first);
  emitter.emit('data', 1);
  assert.deepEqual(runs, ['first']); // new listener deferred to the next pass
  emitter.off('data', first);
  emitter.emit('data', 2);
  assert.deepEqual(runs, ['first', 'second']);
});
