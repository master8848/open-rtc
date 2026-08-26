/**
 * Horizontal proof — 2 server instances behind a LB share room via a distributed
 * Relay (RedisRelay / PostgresNotifyRelay). Uses an in-memory pub/sub bus so the
 * test needs no Redis/Postgres.
 *
 * Covers plans/04-transport-signaling-scale.md §Acceptance (2-instance LB) and
 * plans/00-overview.md §burst test (20 ICE/s zero drops) via the relay + local
 * RoomHub fan-out path.
 *
 * Pattern: node:test + node:assert/strict + InMemoryStore + createEnvelope
 * (see packages/server/test/ws.test.ts).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createEnvelope, type Envelope } from '@mbsks/openrtc-protocol';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';
import { RoomHub } from '../src/ws.ts';
import { RedisRelay, type RedisPub, type RedisSub } from '../src/relays/redis-relay.ts';
import { PostgresNotifyRelay, type PgPoolLike, type PgClientLike } from '../src/relays/postgres-notify-relay.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSocket() {
  const received: Envelope[] = [];
  const sock: any = {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      try { received.push(JSON.parse(payload) as Envelope); } catch { /* ignore */ }
    },
  };
  return { sock: sock as import('ws').WebSocket, received };
}

function envelope(roomId: string, senderId: string, type: string, payload: unknown): Envelope {
  return createEnvelope(type as never, { roomId, senderId, sessionId: `s-${senderId}`, payload } as never) as Envelope;
}

// In-memory Redis bus shared across two relay instances.
// publish() delivers to every sub whose channel matches.
class InMemoryRedisBus {
  private subs = new Map<string, Set<(channel: string, message: string) => void>>();
  createPub(): RedisPub {
    return {
      publish: async (channel: string, message: string) => {
        const handlers = this.subs.get(channel);
        if (handlers) for (const h of [...handlers]) h(channel, message);
        return handlers?.size ?? 0;
      },
    };
  }
  createSub(): RedisSub {
    const handlers = new Set<(channel: string, message: string) => void>();
    let onMessage: ((channel: string, message: string) => void) | null = null;
    const sub: RedisSub = {
      subscribe: async (channel: string) => {
        let s = this.subs.get(channel);
        if (!s) { s = new Set(); this.subs.set(channel, s); }
        if (onMessage) s.add(onMessage);
        // track which channels this sub is on
        subscribed.add(channel);
      },
      unsubscribe: async (channel: string) => {
        const s = this.subs.get(channel);
        if (s && onMessage) s.delete(onMessage);
        if (s && s.size === 0) this.subs.delete(channel);
        subscribed.delete(channel);
      },
      on: (event: 'message', handler: (channel: string, message: string) => void) => {
        if (event === 'message') {
          onMessage = handler;
          // retroactively bind to already-subscribed channels
          for (const ch of subscribed) {
            let s = this.subs.get(ch);
            if (!s) { s = new Set(); this.subs.set(ch, s); }
            s.add(handler);
          }
        }
      },
    };
    const subscribed = new Set<string>();
    return sub;
  }
}

// In-memory Postgres NOTIFY bus — single channel 'vidcall_room', JSON payload.
class InMemoryPgBus {
  private listeners = new Set<(msg: { channel: string; payload?: string }) => void>();
  createPool(): PgPoolLike {
    return {
      query: async (_sql: string, params?: unknown[]) => {
        const channel = params?.[0] as string;
        const payload = params?.[1] as string | undefined;
        if (channel) for (const h of [...this.listeners]) h({ channel, payload });
        return { rows: [] };
      },
    };
  }
  createClient(): PgClientLike {
    let handler: ((msg: { channel: string; payload?: string }) => void) | null = null;
    return {
      query: async () => {},
      on: (event: string, h: (msg: { channel: string; payload?: string }) => void) => {
        if (event === 'notification') { handler = h; this.listeners.add(h); }
      },
      off: (event: string, h: (...args: unknown[]) => void) => {
        if (event === 'notification' && handler) { this.listeners.delete(handler as never); }
        void h;
      },
    };
  }
}

function nextTick(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }

// ---------------------------------------------------------------------------
// RedisRelay: two instances sharing the bus can broadcast across the LB line
// ---------------------------------------------------------------------------

describe('horizontal: 2 instances via RedisRelay mock', () => {
  test('alice on instance A, bob on instance B: offer from A reaches B', async () => {
    const bus = new InMemoryRedisBus();
    const relayA = new RedisRelay(bus.createPub(), bus.createSub());
    const relayB = new RedisRelay(bus.createPub(), bus.createSub());

    const alice = makeMockSocket();
    const bob = makeMockSocket();

    relayA.attach('room1', alice.sock, 'alice', 's-alice');
    relayB.attach('room1', bob.sock, 'bob', 's-bob');
    await nextTick(); // subscribe round-trip

    const offer = envelope('room1', 'alice', 'offer', { sdp: 'v=0 offer' });
    relayA.broadcast('room1', offer, { exceptSenderId: 'alice' });
    await nextTick();

    // alice does NOT get her own offer (local exceptSenderId + relay exceptSenderId)
    assert.equal(alice.received.length, 0);
    // bob on the other instance DOES get it via Redis pub/sub
    assert.equal(bob.received.length, 1);
    assert.equal(bob.received[0]!.type, 'offer');
    assert.equal(bob.received[0]!.senderId, 'alice');
  });

  test('exceptSenderId is honoured across instances', async () => {
    const bus = new InMemoryRedisBus();
    const relayA = new RedisRelay(bus.createPub(), bus.createSub());
    const relayB = new RedisRelay(bus.createPub(), bus.createSub());
    const aliceA = makeMockSocket();
    const aliceB = makeMockSocket(); // same senderId on other instance (multi-tab)
    const bob = makeMockSocket();
    relayA.attach('room1', aliceA.sock, 'alice', 's-alice');
    relayB.attach('room1', aliceB.sock, 'alice', 's-alice-2');
    relayB.attach('room1', bob.sock, 'bob', 's-bob');
    await nextTick();
    // alice sends; both alice sockets must not receive
    const chat = envelope('room1', 'alice', 'chat', { text: 'hi' });
    relayA.broadcast('room1', chat, { exceptSenderId: 'alice' });
    await nextTick();
    assert.equal(aliceA.received.length, 0);
    assert.equal(aliceB.received.length, 0);
    assert.equal(bob.received.length, 1);
  });

  test('RoomHub isolation: without relay, instance B does not see A broadcasts', async () => {
    const hubA = new RoomHub();
    const hubB = new RoomHub();
    const alice = makeMockSocket();
    const bob = makeMockSocket();
    hubA.attach('room1', alice.sock, 'alice', 's-alice');
    hubB.attach('room1', bob.sock, 'bob', 's-bob');
    const offer = envelope('room1', 'alice', 'offer', { sdp: 'v=0' });
    hubA.broadcast('room1', offer, { exceptSenderId: 'alice' });
    // bob is on B, not A → no delivery without relay
    assert.equal(bob.received.length, 0);
  });

  test('subscribed set: unsubscribes when last local socket leaves', async () => {
    const bus = new InMemoryRedisBus();
    let publishCount = 0;
    let unsubscribeCount = 0;
    const base = new InMemoryRedisBus();
    // wrap the sub to count unsubscribes / publishes directly on the relay's interfaces
    const pub = base.createPub();
    const sub = base.createSub();
    const origPublish = pub.publish.bind(pub);
    pub.publish = async (ch: string, msg: string) => { publishCount++; return origPublish(ch, msg); };
    const origUnsub = sub.unsubscribe.bind(sub);
    sub.unsubscribe = async (ch: string) => { unsubscribeCount++; return origUnsub(ch); };
    const relay = new RedisRelay(pub, sub);
    const a = makeMockSocket();
    const b = makeMockSocket();
    relay.attach('room1', a.sock, 'alice', 's-a');
    relay.attach('room1', b.sock, 'bob', 's-b');
    await nextTick();
    // only one subscribe for the room (deduped by subscribed set)
    relay.detach('room1', a.sock);
    await nextTick();
    assert.equal(unsubscribeCount, 0); // b still in room
    relay.detach('room1', b.sock);
    await nextTick();
    assert.equal(unsubscribeCount, 1); // last leaves → unsubscribe
    // further broadcasts still publish but have no subscribers on that channel
    void publishCount;
  });

  test('burst: 20 ICE candidates per second zero drops via relay', async () => {
    const bus = new InMemoryRedisBus();
    const relayA = new RedisRelay(bus.createPub(), bus.createSub());
    const relayB = new RedisRelay(bus.createPub(), bus.createSub());
    const bob = makeMockSocket();
    relayB.attach('room-burst', bob.sock, 'bob', 's-bob');
    await nextTick();
    const N = 20;
    for (let i = 0; i < N; i++) {
      const ice = envelope('room-burst', 'alice', 'ice', { candidate: `cand-${i}` });
      relayA.broadcast('room-burst', ice);
    }
    await nextTick();
    assert.equal(bob.received.length, N, `expected ${N} ICE candidates, got ${bob.received.length}`);
    // verify ordering preserved (relay + local both FIFO)
    for (let i = 0; i < N; i++) assert.equal((bob.received[i]!.payload as { candidate: string }).candidate, `cand-${i}`);
  });
});

// ---------------------------------------------------------------------------
// PostgresNotifyRelay: two instances via shared NOTIFY bus, including chunker
// ---------------------------------------------------------------------------

describe('horizontal: 2 instances via PostgresNotifyRelay mock', () => {
  test('broadcast reaches other instance (pool+dedicated client)', async () => {
    const bus = new InMemoryPgBus();
    const poolA = bus.createPool();
    const clientA = bus.createClient();
    const poolB = bus.createPool();
    const clientB = bus.createClient();
    const relayA = new PostgresNotifyRelay(poolA, clientA);
    const relayB = new PostgresNotifyRelay(poolB, clientB);
    await relayA.start();
    await relayB.start();
    const alice = makeMockSocket();
    const bob = makeMockSocket();
    relayA.attach('room-pg', alice.sock, 'alice', 's-a');
    relayB.attach('room-pg', bob.sock, 'bob', 's-b');
    const chat = envelope('room-pg', 'alice', 'chat', { text: 'pg hello' });
    relayA.broadcast('room-pg', chat, { exceptSenderId: 'alice' });
    await nextTick();
    assert.equal(alice.received.length, 0);
    assert.equal(bob.received.length, 1);
    assert.equal((bob.received[0]!.payload as { text: string }).text, 'pg hello');
    await relayA.stop();
    await relayB.stop();
  });

  test('chunked SDP (>7KB) reassembles across instances', async () => {
    const bus = new InMemoryPgBus();
    const relayA = new PostgresNotifyRelay(bus.createPool(), bus.createClient());
    const relayB = new PostgresNotifyRelay(bus.createPool(), bus.createClient());
    await relayA.start();
    await relayB.start();
    const bob = makeMockSocket();
    relayB.attach('room-chunk', bob.sock, 'bob', 's-bob');
    const bigSdp = 'v=0\r\n' + 'a=candidate:'.repeat(800); // ~8KB payload
    const offer = envelope('room-chunk', 'alice', 'offer', { sdp: bigSdp });
    assert.ok(JSON.stringify({ envelope: offer }).length > 7000, 'fixture must exceed chunk cap');
    relayA.broadcast('room-chunk', offer);
    // chunked broadcast emits N pg_notify calls; delivery is async per chunk, then reassembled
    await new Promise<void>((r) => setTimeout(r, 30));
    assert.equal(bob.received.length, 1);
    assert.equal((bob.received[0]!.payload as { sdp: string }).sdp, bigSdp);
    await relayA.stop();
    await relayB.stop();
  });

  test('burst: 20 ICE/s zero drops via PostgresNotifyRelay (non-chunked)', async () => {
    const bus = new InMemoryPgBus();
    const relayA = new PostgresNotifyRelay(bus.createPool(), bus.createClient());
    const relayB = new PostgresNotifyRelay(bus.createPool(), bus.createClient());
    await relayA.start();
    await relayB.start();
    const bob = makeMockSocket();
    relayB.attach('room-burst-pg', bob.sock, 'bob', 's-bob');
    for (let i = 0; i < 20; i++) {
      relayA.broadcast('room-burst-pg', envelope('room-burst-pg', 'alice', 'ice', { candidate: `c${i}` }));
    }
    await nextTick();
    assert.equal(bob.received.length, 20);
    await relayA.stop();
    await relayB.stop();
  });

  test('store sharing: InMemoryStore can be shared across instances (no fork)', async () => {
    const store = new InMemoryStore();
    // simulate two HTTP servers sharing the same store object/DB behind LB
    const { createRoom, joinRoom, handleSignal } = await import('../src/core.ts');
    await createRoom(store, { roomId: 'shared-room' });
    await joinRoom(store, 'shared-room', { participantId: 'alice', sessionId: 's-a' });
    await joinRoom(store, 'shared-room', { participantId: 'bob', sessionId: 's-b' });
    const sig = await handleSignal(store, envelope('shared-room', 'alice', 'chat', { text: 'shared' }));
    assert.equal(sig.envelope.type, 'chat');
    const signals = await store.listSignals('shared-room', 0);
    assert.equal(signals.length, 1);
    // second "instance" sees same signals without re-creating room
    const signals2 = await store.listSignals('shared-room', 0);
    assert.equal(signals2.length, 1);
  });
});
