import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStoreTestSuite } from '../src/shared-tests.ts';
import { MysqlStore } from '../src/stores/MysqlStore.ts';

/**
 * Real-MySQL integration suite. Runs when `VIDCALL_TEST_MYSQL_URL` is set;
 * skipped otherwise (CI without a MySQL server stays green).
 *
 *   docker run -d --name vidcall-mysql -e MYSQL_ROOT_PASSWORD=vidcall \
 *     -e MYSQL_DATABASE=vidcall_test -e MYSQL_USER=vidcall -e MYSQL_PASSWORD=vidcall \
 *     -p 3307:3306 mysql:8.4
 *   VIDCALL_TEST_MYSQL_URL=mysql://vidcall:vidcall@127.0.0.1:3307/vidcall_test \
 *     node --test packages/server/test/MysqlStore.test.ts
 */

const url = process.env.VIDCALL_TEST_MYSQL_URL;

if (!url) {
  test('MysqlStore: integration suite (skipped — set VIDCALL_TEST_MYSQL_URL)', (t) => {
    t.skip();
  });
} else {
  test('MysqlStore: bootstrap creates tables and is idempotent', async () => {
    const store = new MysqlStore(url);
    await store.bootstrap();
    await store.bootstrap();
    const room = await store.getRoom('__bootstrap_probe__');
    assert.equal(room, null);
    await store.close();
  });

  runStoreTestSuite({
    name: 'mysql',
    roomPrefix: `my-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createStore: async () => {
      const store = new MysqlStore(url);
      await store.bootstrap();
      return store;
    },
    destroyStore: async (store) => {
      await (store as MysqlStore).close();
    },
  });
}
