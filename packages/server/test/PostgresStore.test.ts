import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStoreTestSuite } from '../src/shared-tests.ts';
import { PostgresStore } from '../src/stores/PostgresStore.ts';

/**
 * Real-PostgreSQL integration suite. Runs when `VIDCALL_TEST_POSTGRES_URL`
 * is set; skipped otherwise (CI without a Postgres stays green).
 *
 *   docker run -d --name vidcall-pg -e POSTGRES_PASSWORD=vidcall \
 *     -e POSTGRES_USER=vidcall -e POSTGRES_DB=vidcall_test -p 5433:5432 postgres:15
 *   VIDCALL_TEST_POSTGRES_URL=postgres://vidcall:vidcall@127.0.0.1:5433/vidcall_test \
 *     node --test packages/server/test/PostgresStore.test.ts
 */

const url = process.env.VIDCALL_TEST_POSTGRES_URL;

if (!url) {
  test('PostgresStore: integration suite (skipped — set VIDCALL_TEST_POSTGRES_URL)', (t) => {
    t.skip();
  });
} else {
  test('PostgresStore: bootstrap creates tables and is idempotent', async () => {
    const store = new PostgresStore(url);
    await store.bootstrap();
    await store.bootstrap(); // second run must not throw
    const room = await store.getRoom('__bootstrap_probe__');
    assert.equal(room, null);
    await store.close();
  });

  runStoreTestSuite({
    name: 'postgres',
    roomPrefix: `pg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createStore: async () => {
      const store = new PostgresStore(url);
      await store.bootstrap();
      return store;
    },
    destroyStore: async (store) => {
      await (store as PostgresStore).close();
    },
  });
}
