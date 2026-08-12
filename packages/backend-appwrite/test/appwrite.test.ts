import { describe, it, expect } from 'vitest';
import { createEnvelope } from '@vidcall/protocol';
import type { Databases, Realtime } from 'appwrite';
import { AppwriteBackend } from '../src/AppwriteBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
import type { SignalingTransport } from '@vidcall/transport';
import { FakeAppwriteStore, FakeDatabases, FakeRealtime } from './fakes.js';

// one fake Appwrite project per test file
const store = new FakeAppwriteStore();

function makePeer(): AppwriteBackend {
  return new AppwriteBackend({
    databases: new FakeDatabases(store) as unknown as Databases,
    realtime: store.realtime as unknown as Realtime,
    databaseId: 'main',
    presenceTimeoutMs: 30_000,
  });
}

describe('AppwriteBackend', () => {
  it('exposes appwrite metadata', () => {
    const b = makePeer();
    expect(b.name).toBe('appwrite');
    expect(b.ordering).toBe('seq-required');
    expect(b.maxPayloadBytes).toBe(256 * 1024);
  });

  it('requires services or a client', () => {
    expect(() => new AppwriteBackend({ databaseId: 'main' } as never)).toThrow(/services or a client/);
  });

  it('delivers a message written by the far peer via document events', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-sig', { id: 'a' });
    await b.join('r-sig', { id: 'b' });

    const got: unknown[] = [];
    b.onMessage((e) => got.push(e));

    await a.emit(createEnvelope('chat', { roomId: 'r-sig', senderId: 'a', sessionId: 's', seq: 0, payload: { text: 'via appwrite' } }));
    await waitFor(() => got.length >= 1);
    expect((got[0] as { payload: { text: string } }).payload.text).toBe('via appwrite');

    await a.dispose();
    await b.dispose();
  });

  it('does not deliver own echoes (dedupe by $id + senderId)', async () => {
    const a = makePeer();
    await a.join('r-self', { id: 'a' });
    const got: unknown[] = [];
    a.onMessage((e) => got.push(e));
    await a.emit(createEnvelope('chat', { roomId: 'r-self', senderId: 'a', sessionId: 's', seq: 0, payload: { text: 'self' } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBe(0);
    await a.dispose();
  });

  it('presence: upsert updates and leave emits offline via delete event', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-pres', { id: 'a' });
    await b.join('r-pres', { id: 'b' });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));

    await a.setPresence('online', { name: 'alice' });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'online'));

    await a.setPresence('busy', { name: 'alice', camOn: true });
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'busy'));

    await a.leave();
    await waitFor(() => seen.some((p) => p.id === 'a' && p.state === 'offline'));

    await a.dispose();
    await b.dispose();
  });

  it('late joiner sees existing presence via the listDocuments snapshot', async () => {
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

// shared adapter matrix against the fake Appwrite project
runAdapterTestSuite({
  name: 'appwrite (fake)',
  createPeer: async (): Promise<SignalingTransport> => makePeer(),
  destroyPeer: async (p) => p.dispose(),
  supportsLargePayload: true,
  roomPrefix: 'aw',
} satisfies AdapterHarness);

async function waitFor(cond: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}
