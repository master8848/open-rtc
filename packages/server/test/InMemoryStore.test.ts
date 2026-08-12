import { test } from 'node:test';
import { runStoreTestSuite } from '../src/shared-tests.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';

test('InMemoryStore: dedicated unit checks', async () => {
  const store = new InMemoryStore();
  // Fresh store is empty; the shared suite covers the contract.
});

runStoreTestSuite({
  name: 'in-memory',
  createStore: async () => new InMemoryStore(),
});
