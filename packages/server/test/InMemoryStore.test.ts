import { runStoreTestSuite } from '../src/shared-tests.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';

runStoreTestSuite({
  name: 'in-memory',
  createStore: async () => new InMemoryStore(),
});
