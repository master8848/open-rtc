/**
 * Integration tests — run only when VIDCALL_TEST_SUPABASE_URL and
 * VIDCALL_TEST_SUPABASE_ANON_KEY are set:
 *
 *   VIDCALL_TEST_SUPABASE_URL=https://<ref>.supabase.co \
 *   VIDCALL_TEST_SUPABASE_ANON_KEY=<anon-key> \
 *   npx vitest run test/integration.test.ts
 *
 * Requires a Supabase project with Realtime enabled (broadcast + presence are
 * available on every project by default).
 */
import { describe, it, expect } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseBackend } from '../src/SupabaseBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';

const url = process.env.VIDCALL_TEST_SUPABASE_URL;
const anonKey = process.env.VIDCALL_TEST_SUPABASE_ANON_KEY;
const enabled = Boolean(url && anonKey);

const describeIf = enabled ? describe : describe.skip;

function makeClient(): SupabaseClient {
  return createClient(url!, anonKey!, { realtime: { params: { eventsPerSecond: 20 } } });
}

describeIf('SupabaseBackend integration', () => {
  it('real broadcast + presence round trip', async () => {
    const a = new SupabaseBackend({ client: makeClient() });
    const b = new SupabaseBackend({ client: makeClient() });
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
      payload: { text: 'hello from integration' },
    });

    // wait up to 10 s for the round trip
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && got.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(got.length).toBe(1);
    expect((got[0] as { payload?: { text?: string } }).payload?.text).toBe('hello from integration');

    await a.dispose();
    await b.dispose();
  });

  runAdapterTestSuite({
    name: 'supabase (live)',
    createPeer: async (): Promise<SignalingTransport> => new SupabaseBackend({ client: makeClient() }),
    destroyPeer: async (p) => p.dispose(),
    roomPrefix: 'sup-live',
  } satisfies AdapterHarness);
});
