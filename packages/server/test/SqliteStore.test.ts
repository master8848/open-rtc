import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runStoreTestSuite } from '../src/shared-tests.ts';
import { SqliteStore } from '../src/stores/SqliteStore.ts';

test('SqliteStore: bootstrap is idempotent', async () => {
  const db = new Database(':memory:');
  const store = new SqliteStore(db);
  await store.bootstrap();
  await store.bootstrap();
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vidcall_rooms'")
      .get() !== undefined,
    true,
  );
  db.close();
});

runStoreTestSuite({
  name: 'sqlite',
  createStore: async () => {
    const store = new SqliteStore(new Database(':memory:'));
    await store.bootstrap();
    return store;
  },
  destroyStore: async (store) => {
    (store as SqliteStore).close();
  },
});
