import { afterAll, describe, it, expect } from 'vitest';
import { createEnvelope } from '@mbsks/openrtc-protocol';
import { InMemoryBackend } from '../src/InMemoryBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '../src/shared-tests.js';
import type { SignalingTransport } from '../src/types.js';

describe('InMemoryBackend basics', () => {
  it('delivers messages to subscribers in the room', async () => {
    const a = new InMemoryBackend();
    const b = new InMemoryBackend();
    await a.join('r', { id: 'a' });
    await b.join('r', { id: 'b' });
    const got: string[] = [];
    b.onMessage((e) => got.push((e.payload as { text: string }).text));
    await a.emit(
      createEnvelope('chat', {
        roomId: 'r',
        senderId: 'a',
        sessionId: 's',
        seq: 0,
        payload: { text: 'hi' },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['hi']);
    await a.dispose();
    await b.dispose();
  });

  it('is a SignalingTransport with metadata', () => {
    const b = new InMemoryBackend();
    expect(b.name).toBe('memory');
    expect(b.ordering).toBe('guaranteed');
    expect(b.maxPayloadBytes).toBeGreaterThan(0);
  });

  it('enforces one room per instance', async () => {
    const b = new InMemoryBackend();
    await b.join('r1', { id: 'a' });
    await expect(b.join('r2', { id: 'a' })).rejects.toThrow(/already in room/);
    await b.dispose();
  });

  it('rejects emits for the wrong room', async () => {
    const b = new InMemoryBackend();
    await b.join('r1', { id: 'a' });
    await expect(
      b.emit(
        createEnvelope('chat', {
          roomId: 'r2',
          senderId: 'a',
          sessionId: 's',
          seq: 0,
          payload: { text: 'x' },
        }),
      ),
    ).rejects.toThrow();
    await b.dispose();
  });

  it('leave() reports offline presence to other peers', async () => {
    const a = new InMemoryBackend();
    const b = new InMemoryBackend();
    await a.join('r', { id: 'a' });
    await b.join('r', { id: 'b' });
    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));
    await a.setPresence('online', { name: 'alice' });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.some((p) => p.id === 'a' && p.state === 'online')).toBe(true);
    await a.leave();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.some((p) => p.id === 'a' && p.state === 'offline')).toBe(true);
    await a.dispose();
    await b.dispose();
  });

  it('targetSenderId unicast', async () => {
    const a = new InMemoryBackend();
    const b = new InMemoryBackend();
    const c = new InMemoryBackend();
    await a.join('r', { id: 'a' });
    await b.join('r', { id: 'b' });
    await c.join('r', { id: 'c' });
    const bGot: string[] = [];
    const cGot: string[] = [];
    b.onMessage((e) => bGot.push((e.payload as { text: string }).text));
    c.onMessage((e) => cGot.push((e.payload as { text: string }).text));
    await a.emit(
      createEnvelope('chat', {
        roomId: 'r',
        senderId: 'a',
        sessionId: 's',
        seq: 0,
        targetSenderId: 'b',
        payload: { text: 'only b' },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(bGot).toEqual(['only b']);
    expect(cGot).toEqual([]);
    await a.dispose();
    await b.dispose();
    await c.dispose();
  });
});

// InMemoryBackend is the reference implementation of the shared adapter
// matrix — it must pass every test it defines.
runAdapterTestSuite({
  name: 'memory',
  createPeer: async (_peerId: string): Promise<SignalingTransport> => new InMemoryBackend(),
  destroyPeer: async (p) => p.dispose(),
  roomPrefix: 'inmem',
} satisfies AdapterHarness);

afterAll(() => {
  // nothing to clean: each peer is disposed by the suite
});
