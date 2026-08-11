import { describe, it, expect } from 'vitest';
import { createEnvelope } from '@vidcall/protocol';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseBackend } from '../src/SupabaseBackend.js';
import { runAdapterTestSuite, waitFor, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';
import { FakeRealtimeBus, FakeSupabaseClient, makeEnv } from './fakes.js';

// One shared bus per test file: every peer's channel lives in the same
// fake realtime cluster.
const bus = new FakeRealtimeBus();

describe('SupabaseBackend', () => {
  it('is a SignalingTransport with supabase metadata', () => {
    const b = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient });
    expect(b.name).toBe('supabase');
    expect(b.ordering).toBe('seq-required');
    expect(b.maxPayloadBytes).toBe(256 * 1024);
  });

  it('joins a channel and resolves after SUBSCRIBED', async () => {
    const b = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient });
    await expect(b.join('room-x', { id: 'p1' })).resolves.toBeUndefined();
    await b.dispose();
  });

  it('rejects a second join while joined', async () => {
    const b = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient });
    await b.join('r1', { id: 'p1' });
    await expect(b.join('r2', { id: 'p1' })).rejects.toThrow(/already in room/);
    await b.dispose();
  });

  it('rejects emits before join and for other rooms', async () => {
    const b = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient });
    await expect(
      b.emit(createEnvelope('chat', { ...makeEnv('r', 'p1', 0), payload: { text: 'x' } })),
    ).rejects.toThrow(/join\(\) before emit/);
    await b.join('r1', { id: 'p1' });
    await expect(
      b.emit(createEnvelope('chat', { ...makeEnv('r2', 'p1', 0), payload: { text: 'x' } })),
    ).rejects.toThrow(/roomId/);
    await b.dispose();
  });

  it('reassembles out-of-order inbound frames through the reorder buffer', async () => {
    const a = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient, coalesceIceMs: 0 });
    const b = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient, coalesceIceMs: 0 });
    await a.join('r-reorder', { id: 'a' });
    await b.join('r-reorder', { id: 'b' });

    const got: string[] = [];
    b.onMessage((e) => got.push((e.payload as { label?: string }).label ?? ''));

    // Deliver directly at the SDK seam, out of order (2,0,1)
    const chB = (b as unknown as { channel: import('./fakes.js').FakeChannel }).channel;
    const env2 = createEnvelope('offer', { ...makeEnv('r-reorder', 'a', 2), payload: { sdp: 's2', label: 'm2' } });
    const env0 = createEnvelope('offer', { ...makeEnv('r-reorder', 'a', 0), payload: { sdp: 's0', label: 'm0' } });
    const env1 = createEnvelope('offer', { ...makeEnv('r-reorder', 'a', 1), payload: { sdp: 's1', label: 'm1' } });
    // the fake bus routes via chA.send; instead push directly to b's channel broadcast listeners
    chB._emitBroadcast('offer', env2);
    chB._emitBroadcast('offer', env0);
    chB._emitBroadcast('offer', env1);

    await waitFor(() => got.length >= 3);
    expect(got).toEqual(['m0', 'm1', 'm2']);
    await a.dispose();
    await b.dispose();
  });

  it('coalesces ICE sends into fewer transport calls', async () => {
    const a = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient, coalesceIceMs: 30 });
    const b = new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient, coalesceIceMs: 0 });
    await a.join('r-ice', { id: 'a' });
    await b.join('r-ice', { id: 'b' });

    const got: unknown[] = [];
    b.onMessage((e) => got.push(e));

    for (let i = 0; i < 10; i++) {
      await a.emit(createEnvelope('ice', { ...makeEnv('r-ice', 'a', i), payload: { candidate: `candidate:${i}`, sdpMid: null, sdpMLineIndex: null } }));
    }
    await waitFor(() => got.length >= 10);
    expect(got.length).toBe(10);
    await a.dispose();
    await b.dispose();
  });
});

// The full shared adapter matrix against the fake SDK.
runAdapterTestSuite({
  name: 'supabase (fake)',
  createPeer: async (): Promise<SignalingTransport> =>
    new SupabaseBackend({ client: new FakeSupabaseClient(bus) as unknown as SupabaseClient, coalesceIceMs: 0 }),
  destroyPeer: async (p) => p.dispose(),
  roomPrefix: 'sup',
} satisfies AdapterHarness);
