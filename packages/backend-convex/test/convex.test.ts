import { describe, it, expect } from 'vitest';
import { createEnvelope } from '@mbsks/protocol';
import type { ConvexClient } from 'convex/browser';
import { ConvexBackend } from '../src/ConvexBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@mbsks/transport/shared-tests';
import type { SignalingTransport } from '@mbsks/transport';
import { FakeConvexClient, FakeConvexServer } from './fakes.js';

// one fake Convex deployment per test file
const server = new FakeConvexServer();

function makePeer(): ConvexBackend {
  return new ConvexBackend({
    convex: new FakeConvexClient(server) as unknown as ConvexClient,
    presenceTimeoutMs: 30_000,
  });
}

describe('ConvexBackend', () => {
  it('exposes convex metadata', () => {
    const b = makePeer();
    expect(b.name).toBe('convex');
    expect(b.ordering).toBe('guaranteed');
    expect(b.maxPayloadBytes).toBe(16 * 1024 * 1024);
  });

  it('requires a client or url', () => {
    expect(() => new ConvexBackend({} as never)).toThrow(/client or url/);
  });

  it('delivers a message written by the far peer via the signals subscription', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-sig', { id: 'a' });
    await b.join('r-sig', { id: 'b' });

    const got: unknown[] = [];
    b.onMessage((e) => got.push(e));

    await a.emit(createEnvelope('chat', { roomId: 'r-sig', senderId: 'a', sessionId: 's', seq: 0, payload: { text: 'via convex' } }));
    await waitFor(() => got.length >= 1);
    expect((got[0] as { payload: { text: string } }).payload.text).toBe('via convex');

    await a.dispose();
    await b.dispose();
  });

  it('does not deliver own echoes', async () => {
    const a = makePeer();
    await a.join('r-self', { id: 'a' });
    const got: unknown[] = [];
    a.onMessage((e) => got.push(e));
    await a.emit(createEnvelope('chat', { roomId: 'r-self', senderId: 'a', sessionId: 's', seq: 0, payload: { text: 'self' } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBe(0);
    await a.dispose();
  });

  it('tracks presence through the presence table subscription', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-pres', { id: 'a' });
    await b.join('r-pres', { id: 'b' });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));

    await a.setPresence('online', { name: 'alice' });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'online'));

    await a.setPresence('busy', { name: 'alice' });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'busy'));

    await a.dispose();
    await b.dispose();
  });
});

// shared adapter matrix against the fake Convex deployment
runAdapterTestSuite({
  name: 'convex (fake)',
  createPeer: async (): Promise<SignalingTransport> => makePeer(),
  destroyPeer: async (p) => p.dispose(),
  roomPrefix: 'cvex',
} satisfies AdapterHarness);

async function waitFor(cond: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}
