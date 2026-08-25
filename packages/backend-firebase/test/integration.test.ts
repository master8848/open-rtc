/**
 * Integration tests — run only when VIDCALL_TEST_FIREBASE_API_KEY,
 * VIDCALL_TEST_FIREBASE_PROJECT_ID and VIDCALL_TEST_FIREBASE_DATABASE_URL
 * are set:
 *
 *   VIDCALL_TEST_FIREBASE_API_KEY=... \
 *   VIDCALL_TEST_FIREBASE_PROJECT_ID=... \
 *   VIDCALL_TEST_FIREBASE_DATABASE_URL=https://<project>-default-rtdb.firebaseio.com \
 *   npx vitest run test/integration.test.ts
 *
 * Requires a Firebase project with Realtime Database (Rules can stay in
 * test mode for local runs; secure with auth + rules in production).
 */
import { describe, it, expect } from 'vitest';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getDatabase, type Database } from 'firebase/database';
import { FirebaseBackend } from '../src/FirebaseBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@mbsks/openrtc-transport/shared-tests';
import type { SignalingTransport } from '@mbsks/openrtc-transport';

const apiKey = process.env.VIDCALL_TEST_FIREBASE_API_KEY;
const projectId = process.env.VIDCALL_TEST_FIREBASE_PROJECT_ID;
const databaseURL = process.env.VIDCALL_TEST_FIREBASE_DATABASE_URL;
const enabled = Boolean(apiKey && projectId && databaseURL);

const describeIf = enabled ? describe : describe.skip;

let app: FirebaseApp;
function makeDb(): Database {
  if (!app) {
    app = initializeApp({ apiKey, projectId, databaseURL });
  }
  return getDatabase(app);
}

describeIf('FirebaseBackend integration', () => {
  it('real RTDB signal-log + presence round trip', async () => {
    const a = new FirebaseBackend({ database: makeDb() });
    const b = new FirebaseBackend({ database: makeDb() });
    const room = `vidcall-test-${Date.now()}`;
    await a.join(room, { id: 'a', displayName: 'alice' });
    await b.join(room, { id: 'b', displayName: 'bob' });

    const got: unknown[] = [];
    b.onMessage((e) => got.push(e));
    await a.emit({
      v: 1,
      type: 'chat',
      roomId: room,
      senderId: 'a',
      sessionId: 's-a',
      ts: Date.now(),
      seq: 0,
      payload: { text: 'hello from firebase integration' },
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && got.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(got.length).toBe(1);
    expect((got[0] as { payload?: { text?: string } }).payload?.text).toBe('hello from firebase integration');

    await a.dispose();
    await b.dispose();
  });

  runAdapterTestSuite({
    name: 'firebase (live)',
    createPeer: async (): Promise<SignalingTransport> => new FirebaseBackend({ database: makeDb() }),
    destroyPeer: async (p) => p.dispose(),
    roomPrefix: 'fb-live',
  } satisfies AdapterHarness);
});
