/**
 * FirebaseBackend unit tests against an in-memory RTDB fake.
 *
 * `vi.mock('firebase/database')` swaps the whole firebase/database module for
 * the FakeFirebaseDb singleton in fakes.ts, so the adapter talks to a
 * real-shaped fake (push keys sort chronologically, onChildAdded replays
 * existing children, onDisconnect hooks are executed by
 * `sharedFakeDb.simulateDisconnect()` — exactly like the RTDB server).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEnvelope } from '@mbsks/protocol';
import type { Database } from 'firebase/database';
import { FirebaseBackend } from '../src/FirebaseBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@mbsks/transport/shared-tests';
import type { SignalingTransport } from '@mbsks/transport';
import { sharedFakeDb } from './fakes.js';

vi.mock('firebase/database', async () => {
  const { sharedFakeDb } = await import('./fakes.js');
  return {
    getDatabase: () => sharedFakeDb as never,
    // ref(db, path) is the only firebase/database helper that takes the DB
    // first; every other function takes the ref object (from ref()) first.
    ref: (_db: never, path: string) => sharedFakeDb.ref(path),
    push: (parent: { path: string }, value: unknown) => sharedFakeDb.push(parent, value),
    set: (r: { path: string }, value: unknown) => sharedFakeDb.set(r, value),
    update: (r: { path: string }, values: Record<string, unknown>) => sharedFakeDb.update(r, values),
    remove: (r: { path: string }) => sharedFakeDb.remove(r),
    onChildAdded: (q: { path: string }, cb: (snap: never) => void) => sharedFakeDb.onChildAdded(q, cb),
    onValue: (q: { path: string }, cb: (snap: never) => void) => sharedFakeDb.onValue(q, cb),
    off: (q: { path: string }, eventType?: string, cb?: never) => sharedFakeDb.off(q, eventType, cb),
    onDisconnect: (r: { path: string }) => sharedFakeDb.onDisconnect(r),
  };
});

function makePeer(): FirebaseBackend {
  return new FirebaseBackend({
    database: sharedFakeDb as unknown as Database,
    presenceTimeoutMs: 30_000,
  });
}

describe('FirebaseBackend', () => {
  beforeEach(() => {
    sharedFakeDb.reset();
  });

  it('exposes firebase metadata', () => {
    const b = makePeer();
    expect(b.name).toBe('firebase');
    expect(b.ordering).toBe('guaranteed');
    expect(b.maxPayloadBytes).toBe(16 * 1024 * 1024);
    expect(b).toHaveProperty('join');
    expect(b).toHaveProperty('emit');
    expect(b).toHaveProperty('dispose');
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

    await a.emit(createEnvelope('chat', { roomId: 'r-sig', senderId: 'a', sessionId: 's', seq: 0, payload: { text: 'via firebase' } }));
    await waitFor(() => got.length >= 1);
    expect((got[0] as { payload: { text: string } }).payload.text).toBe('via firebase');

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

  it('tracks presence through the presence path and reports updates', async () => {
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

  it('native onDisconnect presence: a dropped connection reports the peer offline', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-disc', { id: 'a' });
    await b.join('r-disc', { id: 'b' });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));

    await a.setPresence('online', { name: 'alice' });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'online'));

    // simulate the RTDB server running a's onDisconnect hook (crash, not leave)
    sharedFakeDb.simulateDisconnect('a');
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'offline'));

    await a.dispose();
    await b.dispose();
  });

  it('a late joiner sees presence already written by an earlier peer', async () => {
    const a = makePeer();
    await a.join('r-late', { id: 'a' });
    await a.setPresence('online', { name: 'alice' });
    await new Promise((r) => setTimeout(r, 10));

    const b = makePeer();
    const bSeen: { id: string; state: string }[] = [];
    b.onPresence((p) => bSeen.push({ id: p.participantId, state: p.state }));
    await b.join('r-late', { id: 'b' });
    await waitFor(() => bSeen.some((p) => p.id === 'a' && p.state === 'online'));

    await a.dispose();
    await b.dispose();
  });
});

// shared adapter matrix against the fake RTDB
runAdapterTestSuite({
  name: 'firebase (fake)',
  createPeer: async (): Promise<SignalingTransport> => makePeer(),
  destroyPeer: async (p) => p.dispose(),
  roomPrefix: 'fb',
} satisfies AdapterHarness);

async function waitFor(cond: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within ' + timeoutMs + 'ms');
}
