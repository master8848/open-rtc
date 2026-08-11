/**
 * Integration tests — run only when VIDCALL_TEST_CONVEX_URL is set:
 *
 *   VIDCALL_TEST_CONVEX_URL=https://<deployment>.convex.cloud \
 *   npx vitest run test/integration.test.ts
 *
 * Requires the reference functions to be deployed (copy the package's
 * `convex/` directory into your project and run `npx convex deploy`).
 */
import { describe } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { ConvexBackend } from '../src/ConvexBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';

const url = process.env.VIDCALL_TEST_CONVEX_URL;
const enabled = Boolean(url);
const describeIf = enabled ? describe : describe.skip;

describeIf('ConvexBackend integration', () => {
  runAdapterTestSuite({
    name: 'convex (live)',
    createPeer: async (): Promise<SignalingTransport> => new ConvexBackend({ url: url! }),
    destroyPeer: async (p) => p.dispose(),
    roomPrefix: 'cvex-live',
  } satisfies AdapterHarness);
});
