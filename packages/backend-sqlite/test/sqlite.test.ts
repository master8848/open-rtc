import { describe, it, expect } from 'vitest';
import { createEnvelope, type Envelope } from '@mbsks/protocol';
import { createClient, type Client } from '@libsql/client';
import { SqliteBackend } from '../src/SqliteBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@mbsks/transport/shared-tests';
import type { SignalingTransport } from '@mbsks/transport';

function makePeer(): SqliteBackend {
  return new SqliteBackend({
    client: createClient({ url: ':memory:' }),
    channelPrefix: 'vc-test',
    heartbeatMs: 10_000,
    presenceTimeoutMs: 30_000,
  });
}

describe('SqliteBackend', () => {
  it('exposes sqlite metadata', () => {
    const b = makePeer();
    expect(b.name).toBe('sqlite');
    expect(b.ordering).toBe('guaranteed');
    expect(b.maxPayloadBytes).toBe(1024 * 1024);
    void b.dispose();
  });

  it('joins a room and resolves', async () => {
    const b = makePeer();
    await expect(b.join('room-x', { id: 'p1' })).resolves.toBeUndefined();
    expect(b.room).toBe('room-x');
    await b.dispose();
  });

  it('rejects a second join while joined', async () => {
    const b = makePeer();
    await b.join('r1', { id: 'p1' });
    await expect(b.join('r2', { id: 'p1' })).rejects.toThrow(/already in room/);
    await b.dispose();
  });

  it('rejects emits before join and for other rooms', async () => {
    const b = makePeer();
    await expect(
      b.emit(createEnvelope('chat', { roomId: 'r', senderId: 'p1', sessionId: 's', seq: 0, payload: { text: 'x' } })),
    ).rejects.toThrow(/join\(\) before emit/);
    await b.join('r1', { id: 'p1' });
    await expect(
      b.emit(createEnvelope('chat', { roomId: 'r2', senderId: 'p1', sessionId: 's', seq: 0, payload: { text: 'x' } })),
    ).rejects.toThrow(/roomId/);
    await b.dispose();
  });

  it('persists every emitted envelope in the local signal log', async () => {
    const client: Client = createClient({ url: ':memory:' });
    const b = new SqliteBackend({ client, channelPrefix: 'vc-test' });
    await b.join('r-log', { id: 'p1' });
    await b.emit(createEnvelope('chat', { roomId: 'r-log', senderId: 'p1', sessionId: 's', seq: 0, payload: { text: 'hi' } }));
    const rows = (await client.execute('SELECT * FROM vidcall_signals')).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.room_id).toBe('r-log');
    expect(rows[0]!.sender_id).toBe('p1');
    const frame = JSON.parse(rows[0]!.frame as string) as Envelope;
    expect(frame.type).toBe('chat');
    expect((frame.payload as { text: string }).text).toBe('hi');
    await b.dispose();
  });

  it('persists presence rows and removes them on leave', async () => {
    const client: Client = createClient({ url: ':memory:' });
    const b = new SqliteBackend({ client, channelPrefix: 'vc-test' });
    await b.join('r-pres', { id: 'p1' });
    await b.setPresence('online', { name: 'alice' });
    let rows = (await client.execute('SELECT * FROM vidcall_presence')).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.state).toBe('online');
    expect(JSON.parse(rows[0]!.metadata as string)).toEqual({ name: 'alice' });

    await b.leave();
    rows = (await client.execute('SELECT * FROM vidcall_presence')).rows;
    expect(rows.length).toBe(0);
    await b.dispose();
  });

  it('replies to presence-sync so a late joiner sees existing presence', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-sync', { id: 'a' });
    await a.setPresence('busy', { camOn: true });

    const seen: { id: string; state: string }[] = [];
    b.onPresence((p) => seen.push({ id: p.participantId, state: p.state }));
    await b.join('r-sync', { id: 'b' });

    // b's join posts a presence-sync request; a replies with its presence
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !seen.some((p) => p.id === 'a' && p.state === 'busy')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.some((p) => p.id === 'a' && p.state === 'busy')).toBe(true);
    expect(seen.some((p) => p.id === 'a' && p.state === 'busy')).toBe(true);
    await a.dispose();
    await b.dispose();
  });

  it('broadcasts an offline presence frame on leave', async () => {
    const a = makePeer();
    const b = makePeer();
    await a.join('r-off', { id: 'a' });
    await b.join('r-off', { id: 'b' });

    const seen: string[] = [];
    b.onPresence((p) => seen.push(`${p.participantId}:${p.state}`));
    await a.setPresence('online', {});
    await a.leave();

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !seen.includes('a:offline')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).toContain('a:offline');
    await a.dispose();
    await b.dispose();
  });
});

// The full shared adapter matrix — real BroadcastChannel + in-memory libSQL,
// all in-process (same-device mode is exactly what this backend is for).
runAdapterTestSuite({
  name: 'sqlite (BroadcastChannel)',
  createPeer: async (): Promise<SignalingTransport> => makePeer(),
  destroyPeer: async (p) => p.dispose(),
  supportsLargePayload: true,
  roomPrefix: 'sq',
} satisfies AdapterHarness);
