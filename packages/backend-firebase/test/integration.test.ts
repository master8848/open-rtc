/**
 * Integration tests — run only when VIDCALL_TEST_FIREBASE_* is set:
 *
 *   VIDCALL_TEST_FIREBASE_API_KEY=... \
 *   VIDCALL_TEST_FIREBASE_PROJECT_ID=... \
 *   VIDCALL_TEST_FIREBASE_DATABASE_URL=... \
 *   npx vitest run test/integration.test.ts
 *
 * Requires a Firebase project with the Realtime Database enabled (test mode
 * rules are fine). Uses the Node SDK's native WebSocket connection.
 */
import { describe } from 'vitest';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { FirebaseBackend } from '../src/FirebaseBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';

const apiKey = process.env.VIDCALL_TEST_FIREBASE_API_KEY;
const projectId = process.env.VIDCALL_TEST_FIREBASE_PROJECT_ID;
const databaseURL = process.env.VIDCALL_TEST_FIREBASE_DATABASE_URL;
const enabled = Boolean(apiKey && projectId && databaseURL);
const describeIf = enabled ? describe : describe.skip;

describeIf('FirebaseBackend integration', () => {
  runAdapterTestSuite({
    name: 'firebase (live)',
    createPeer: async (): Promise<SignalingTransport> => {
      const app = initializeApp({ apiKey: apiKey!, projectId: projectId!, databaseURL: databaseURL! }, `vidcall-${Math.random()}`);
      const db = getDatabase(app);
      return new FirebaseBackend({ database: db as never, presenceTimeoutMs: 30_000 });
    },
    destroyPeer: async (p) => p.dispose(),
    roomPrefix: 'fbr-live',
  } satisfies AdapterHarness);
});
