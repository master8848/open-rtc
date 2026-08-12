/**
 * Integration tests — run only when VIDCALL_TEST_APPWRITE_* is set:
 *
 *   VIDCALL_TEST_APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1 \
 *   VIDCALL_TEST_APPWRITE_PROJECT=<projectId> \
 *   VIDCALL_TEST_APPWRITE_API_KEY=<server API key> \
 *   npx vitest run test/integration.test.ts
 *
 * Requires collections `signals` (roomId/senderId/frame attributes) and
 * `presence` (roomId/userId/state/metadata/lastSeen attributes) in database
 * `main` with realtime enabled.
 */
import { describe } from 'vitest';
import { Client, Databases, Realtime } from 'appwrite';
import { AppwriteBackend } from '../src/AppwriteBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';

const endpoint = process.env.VIDCALL_TEST_APPWRITE_ENDPOINT;
const project = process.env.VIDCALL_TEST_APPWRITE_PROJECT;
const apiKey = process.env.VIDCALL_TEST_APPWRITE_API_KEY;
const enabled = Boolean(endpoint && project && apiKey);
const describeIf = enabled ? describe : describe.skip;

describeIf('AppwriteBackend integration', () => {
  runAdapterTestSuite({
    name: 'appwrite (live)',
    createPeer: async (): Promise<SignalingTransport> => {
      const client = new Client().setEndpoint(endpoint!).setProject(project!).setKey(apiKey!);
      return new AppwriteBackend({
        client,
        databaseId: 'main',
        presenceTimeoutMs: 30_000,
      });
    },
    destroyPeer: async (p) => p.dispose(),
    supportsLargePayload: true,
    roomPrefix: 'aw-live',
  } satisfies AdapterHarness);
});
