import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import WebSocket from 'ws';
import { createEnvelope, type Envelope } from '@vidcall/protocol';
import { createNodeServer } from '../src/http.ts';
import { createServices } from '../src/services.ts';
import { attachWebSocketRelay } from '../src/ws.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<Envelope | Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for WS message')),
      timeoutMs,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Envelope | Record<string, unknown>);
    });
  });
}

interface TestServer {
  base: string;
  wsUrl(roomId: string): string;
  close(): Promise<void>;
  hub: ReturnType<typeof attachWebSocketRelay>['hub'];
}

async function withRelayServer(fn: (srv: TestServer) => Promise<void>): Promise<void> {
  const store = new InMemoryStore();
  const server = createNodeServer(createServices({ store }));
  const relay = attachWebSocketRelay(server, createServices({ store }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({
      base,
      wsUrl: (roomId) => `ws://127.0.0.1:${port}/ws?roomId=${roomId}`,
      close: async () => {
        await relay.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
      hub: relay.hub,
    });
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Create a room via the REST API, then join it over WS (realistic flow). */
async function createRoom(srv: TestServer, roomId: string): Promise<void> {
  const res = await fetch(`${srv.base}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId }),
  });
  assert.equal(res.status, 201);
}

async function connectAndJoin(
  srv: TestServer,
  roomId: string,
  senderId: string,
  displayName?: string,
): Promise<WebSocket> {
  const ws = new WebSocket(srv.wsUrl(roomId));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify(
      createEnvelope('join', {
        roomId,
        senderId,
        sessionId: `s-${senderId}`,
        payload: displayName ? { displayName } : undefined,
      }),
    ),
  );
  const joined = await nextMessage(ws);
  assert.equal(joined.type, 'joined');
  assert.equal((joined as { roomId: string }).roomId, roomId);
  return ws;
}

test('ws: join ack, offer relay to the other member only, answer back', async () => {
  await withRelayServer(async (srv) => {
    await createRoom(srv, 'room1');
    const a = await connectAndJoin(srv, 'room1', 'alice', 'Alice');
    const b = await connectAndJoin(srv, 'room1', 'bob');

    // alice sends an offer; bob receives it; alice does not.
    const bobGot: Promise<unknown> = nextMessage(b);
    a.send(
      JSON.stringify(
        createEnvelope('offer', {
          roomId: 'room1',
          senderId: 'alice',
          sessionId: 's-alice',
          payload: { sdp: 'v=0 offer' },
        }),
      ),
    );
    const offer = await bobGot;
    assert.equal((offer as Envelope).type, 'offer');
    assert.equal((offer as Envelope).senderId, 'alice');
    assert.equal(((offer as Envelope).payload as { sdp: string }).sdp, 'v=0 offer');

    // bob answers; alice receives.
    const aliceGot: Promise<unknown> = nextMessage(a);
    b.send(
      JSON.stringify(
        createEnvelope('answer', {
          roomId: 'room1',
          senderId: 'bob',
          sessionId: 's-bob',
          payload: { sdp: 'v=0 answer' },
        }),
      ),
    );
    const answer = await aliceGot;
    assert.equal((answer as Envelope).type, 'answer');
    assert.equal((answer as Envelope).senderId, 'bob');

    // presence broadcast reaches everyone including the sender.
    const bobPresence: Promise<unknown> = nextMessage(b);
    a.send(
      JSON.stringify(
        createEnvelope('presence', {
          roomId: 'room1',
          senderId: 'alice',
          sessionId: 's-alice',
          payload: { state: 'busy' },
        }),
      ),
    );
    const presence = await bobPresence;
    assert.equal((presence as Envelope).type, 'presence');
    assert.equal(((presence as Envelope).payload as { state: string }).state, 'busy');

    a.close();
    b.close();
  });
});

test('ws: leave envelope is relayed; disconnected sockets auto-leave with reason', async () => {
  await withRelayServer(async (srv) => {
    await createRoom(srv, 'room2');
    const a = await connectAndJoin(srv, 'room2', 'alice');
    const b = await connectAndJoin(srv, 'room2', 'bob');
    const c = await connectAndJoin(srv, 'room2', 'carol');

    // bob leaves explicitly; alice and carol hear about it.
    const aliceGot: Promise<unknown> = nextMessage(a);
    const carolGotBob: Promise<unknown> = nextMessage(c);
    b.send(
      JSON.stringify(
        createEnvelope('leave', { roomId: 'room2', senderId: 'bob', sessionId: 's-bob' }),
      ),
    );
    const leave = await aliceGot;
    assert.equal((leave as Envelope).type, 'leave');
    assert.equal((leave as Envelope).senderId, 'bob');
    const carolLeaveBob = await carolGotBob;
    assert.equal((carolLeaveBob as Envelope).senderId, 'bob');
    b.close();

    // alice drops the connection; carol hears a leave with reason 'disconnect'.
    const carolGot: Promise<unknown> = nextMessage(c);
    a.close();
    const autoLeave = await carolGot;
    assert.equal((autoLeave as Envelope).type, 'leave');
    assert.equal((autoLeave as Envelope).senderId, 'alice');
    assert.equal(((autoLeave as Envelope).payload as { reason?: string }).reason, 'disconnect');
    c.close();
  });
});

test('ws: validation errors (must_join, invalid envelope, unknown room)', async () => {
  await withRelayServer(async (srv) => {
    // sending chat before join → must_join error
    const raw = new WebSocket(srv.wsUrl('room3'));
    await new Promise<void>((resolve, reject) => {
      raw.once('open', resolve);
      raw.once('error', reject);
    });
    raw.send(
      JSON.stringify(
        createEnvelope('chat', {
          roomId: 'room3',
          senderId: 'x',
          sessionId: 'sx',
          payload: { text: 'hi' },
        }),
      ),
    );
    const err1 = (await nextMessage(raw)) as Envelope;
    assert.equal(err1.type, 'error');
    assert.equal((err1.payload as { code: string }).code, 'must_join');
    raw.close();

    // joining an unknown room → room_not_found
    const ws = new WebSocket(srv.wsUrl('room3'));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify(
        createEnvelope('join', { roomId: 'room3', senderId: 'alice', sessionId: 'sa' }),
      ),
    );
    const err2 = (await nextMessage(ws)) as Envelope;
    assert.equal(err2.type, 'error');
    assert.equal((err2.payload as { code: string }).code, 'room_not_found');
    ws.close();

    // invalid JSON → invalid_json
    const ws2 = new WebSocket(srv.wsUrl('room3'));
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', resolve);
      ws2.once('error', reject);
    });
    ws2.send('not json');
    const err3 = (await nextMessage(ws2)) as Envelope;
    assert.equal(err3.type, 'error');
    assert.equal((err3.payload as { code: string }).code, 'invalid_json');
    ws2.close();
  });
});

test('ws: roomId in query is required (400 on upgrade)', async () => {
  const server = http.createServer(() => {});
  const relay = attachWebSocketRelay(server, createServices({ store: new InMemoryStore() }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    assert.equal(outcome, 'error');
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
