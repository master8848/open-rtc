import { describe, it, expect } from 'vitest';
import { createEnvelope } from '@mbsks/openrtc-protocol';
import { PostgresBackend, channelName, presenceChannelName } from '../src/PostgresBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@mbsks/openrtc-transport/shared-tests';
import type { SignalingTransport } from '@mbsks/openrtc-transport';
import { FakePgBus, FakePgClient } from './fakes.js';

// one fake "Postgres server" per test file
const bus = new FakePgBus();

function makePeer(): PostgresBackend {
  return new PostgresBackend({
    client: new FakePgClient(bus) as unknown as import('pg').Client,
    heartbeatMs: 10_000, // keep tests fast; sweeper is exercised explicitly
    presenceTimeoutMs: 30_000,
  });
}

describe('PostgresBackend', () => {
  it('exposes postgres metadata', () => {
    const b = makePeer();
    expect(b.name).toBe('postgres');
    expect(b.ordering).toBe('seq-required');
    expect(b.maxPayloadBytes).toBe(7000);
  });

  it('maps rooms to LISTEN channel names <= 63 chars', () => {
    const ch = channelName('my-room_1');
    expect(ch).toBe('vidcall_msg_my_room_1');
    expect(ch.length).toBeLessThanOrEqual(63);
    expect(presenceChannelName('my-room_1')).toBe('vidcall_presence_my_room_1');
    // long rooms are hashed + truncated
    const long = channelName('a'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
  });

  it('requires a client or connectionString', () => {
    expect(() => new PostgresBackend({} as never)).toThrow(/client or connectionString/);
  });

  it('chunks payloads over the NOTIFY cap and reassembles on the far side', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-chunk', { id: 'a' });
    await b.join('r-chunk', { id: 'b' });

    const got: unknown[] = [];
    b.onMessage((e) => got.push(e));

    const big = '🏠'.repeat(2000) + 'y'.repeat(2000);
    await a.emit(createEnvelope('offer', { roomId: 'r-chunk', senderId: 'a', sessionId: 's', seq: 0, payload: { sdp: big } }));
    await waitFor(() => got.length >= 1, 2000);
    expect((got[0] as { payload: { sdp: string } }).payload.sdp).toBe(big);

    await a.dispose();
    await b.dispose();
  });

  it('persists presence rows and replays them to late joiners', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-pres', { id: 'a' });
    await a.setPresence('online', { name: 'alice' });
    // let the NOTIFY flow
    await new Promise((r) => setTimeout(r, 10));

    const bSeen: { id: string; state: string }[] = [];
    b.onPresence((p) => bSeen.push({ id: p.participantId, state: p.state }));
    await b.join('r-pres', { id: 'b' });
    await new Promise((r) => setTimeout(r, 10));

    // b must see a's presence (from the table replay) + b itself is not echoed
    expect(bSeen.some((p) => p.id === 'a' && p.state === 'online')).toBe(true);

    await a.dispose();
    await b.dispose();
  });
});

// shared adapter matrix against the fake pg server
runAdapterTestSuite({
  name: 'postgres (fake)',
  createPeer: async (): Promise<SignalingTransport> => makePeer(),
  destroyPeer: async (p) => p.dispose(),
  supportsLargePayload: true,
  roomPrefix: 'pg',
} satisfies AdapterHarness);

async function waitFor(cond: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}
