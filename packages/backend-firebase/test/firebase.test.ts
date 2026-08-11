import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createEnvelope } from '@vidcall/protocol';
import { sharedFakeDb } from './fakes.js';

// mock firebase/database BEFORE importing the adapter (vi.mock is hoisted)
vi.mock('firebase/database', async () => {
  const { sharedFakeDb } = await import('./fakes.js');
  return {
    getDatabase: () => sharedFakeDb as never,
    ref: (_db: unknown, path?: string) => sharedFakeDb.ref(path ?? '/'),
    push: (parent: unknown, value: unknown) => sharedFakeDb.push(parent as never, value),
    set: (r: unknown, v: unknown) => sharedFakeDb.set(r as never, v),
    update: (r: unknown, v: unknown) => sharedFakeDb.update(r as never, v as never),
    remove: (r: unknown) => sharedFakeDb.remove(r as never),
    onChildAdded: (q: unknown, cb: unknown) => sharedFakeDb.onChildAdded(q as never, cb as never),
    onValue: (q: unknown, cb: unknown) => sharedFakeDb.onValue(q as never, cb as never),
    off: (q: unknown, ev?: string, cb?: unknown) => sharedFakeDb.off(q as never, ev, cb as never),
    onDisconnect: (r: unknown) => sharedFakeDb.onDisconnect(r as never),
  };
});

import { FirebaseBackend } from '../src/FirebaseBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';

function makePeer(): FirebaseBackend {
  return new FirebaseBackend({
    database: sharedFakeDb as never,
    presenceTimeoutMs: 30_000,
  });
}

beforeEach(() => {
  sharedFakeDb.reset();
});

describe('FirebaseBackend', () => {
  it('exposes firebase metadata', () => {
    const b = makePeer();
    expect(b.name).toBe('firebase');
    expect(b.ordering).toBe('guaranteed');
    expect(b.maxPayloadBytes).toBe(16 * 1024 * 1024);
  });

  it('requires a database or app', () => {
    expect(() => new FirebaseBackend({} as never)).toThrow(/database or app/);
  });

  it('delivers a message written by the far peer via the signal log', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-sig', { id: 'a' });
    await b.join('r-sig', { id: 'b' });

    const got: unknown[] = [];
    b.onMessage((e) => got.push(e));

    await a.emit(createEnvelope('chat', { roomId: 'r-sig', senderId: 'a', sessionId: 's', seq: 0, payload: { text: 'via rtdb' } }));
    await waitFor(() => got.length >= 1);
    expect((got[0] as { payload: { text: string } }).payload.text).toBe('via rtdb');

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

  it('native presence: onDisconnect marks the peer offline on crash', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-crash', { id: 'a' });
    await b.join('r-crash', { id: 'b' });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));
    await a.setPresence('online', { name: 'alice' });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'online'));

    // simulate a network drop — the RTDB server would run a's onDisconnect hook
    sharedFakeDb.simulateDisconnect('a');
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'offline'));

    await a.dispose();
    await b.dispose();
  });

  it('presence: leave removes the row and peers see offline', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-leave', { id: 'a' });
    await b.join('r-leave', { id: 'b' });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));
    await a.setPresence('online');
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'online'));

    await a.leave();
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'offline'));

    await a.dispose();
    await b.dispose();
  });

  it('late joiner sees existing presence from the snapshot', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-late', { id: 'a' });
    await a.setPresence('online', { name: 'alice' });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));
    await b.join('r-late', { id: 'b' });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'online'));

    await a.dispose();
    await b.dispose();
  });
});

// shared adapter matrix against the fake RTDB
runAdapterTestSuite({
  name: 'firebase (fake)',
  createPeer: async (): Promise<SignalingTransport> => makePeer(),
  destroyPeer: async (p) => p.dispose(),
  roomPrefix: 'fbr',
} satisfies AdapterHarness);

async function waitFor(cond: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}
