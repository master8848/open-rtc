import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createEnvelope, type Envelope } from '@mbsks/protocol';
import { createNodeServer } from '../src/http.ts';
import { createServices } from '../src/services.ts';
import { attachWebSocketRelay } from '../src/ws.ts';
import { InMemoryStore } from '../src/stores/InMemoryStore.ts';
import { createRoom, joinRoom } from '../src/core.ts';
import { AuthError, DEFAULT_TOKEN_TTL_SECONDS, issueToken, verifyToken } from '../src/auth.ts';

const SECRET = 'test-secret';

// ---------------------------------------------------------------------------
// Token unit tests
// ---------------------------------------------------------------------------

test('auth: token roundtrip (issue -> verify) with defaults', () => {
  const token = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });
  const claims = verifyToken(SECRET, token);
  assert.equal(claims.roomId, 'r1');
  assert.equal(claims.participantId, 'alice');
  assert.equal(claims.role, 'participant');
  assert.ok(claims.exp > claims.iat, 'exp must be after iat');
  // default TTL ≈ 1h
  const ttl = claims.exp - claims.iat;
  assert.ok(ttl <= DEFAULT_TOKEN_TTL_SECONDS && ttl > DEFAULT_TOKEN_TTL_SECONDS - 10, `ttl=${ttl}`);
  // compact JWT-ish shape: header.payload.signature
  assert.equal(token.split('.').length, 3);
});

test('auth: explicit role and exp round-trip', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = issueToken(SECRET, {
    roomId: 'r1',
    participantId: 'root',
    role: 'admin',
    exp,
  });
  const claims = verifyToken(SECRET, token);
  assert.equal(claims.role, 'admin');
  assert.equal(claims.exp, exp);
});

test('auth: tampered signature and payload are rejected', () => {
  const token = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });

  // flip one char of the signature
  const flippedSig = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.throws(
    () => verifyToken(SECRET, flippedSig),
    (e: unknown) => e instanceof AuthError && e.code === 'unauthorized',
  );

  // rewrite the payload (role escalation) without re-signing
  const [h, p] = token.split('.') as [string, string];
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as {
    roomId: string;
    participantId: string;
    role: string;
  };
  payload.role = 'admin';
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  assert.throws(
    () => verifyToken(SECRET, `${forged}.${token.split('.')[2]}`),
    (e: unknown) => e instanceof AuthError && e.code === 'unauthorized',
  );
});

test('auth: wrong secret is rejected', () => {
  const token = issueToken('secret-a', { roomId: 'r1', participantId: 'alice' });
  assert.throws(
    () => verifyToken('secret-b', token),
    (e: unknown) => e instanceof AuthError && e.code === 'unauthorized',
  );
});

test('auth: expired token is rejected with token_expired', () => {
  const past = Math.floor(Date.now() / 1000) - 5;
  const token = issueToken(SECRET, { roomId: 'r1', participantId: 'alice', exp: past });
  assert.throws(
    () => verifyToken(SECRET, token),
    (e: unknown) => e instanceof AuthError && e.code === 'token_expired' && e.status === 401,
  );
});

test('auth: malformed tokens are rejected', () => {
  assert.throws(
    () => verifyToken(SECRET, 'not-a-token'),
    (e: unknown) => e instanceof AuthError && e.code === 'unauthorized',
  );
  assert.throws(() => verifyToken(SECRET, ''), AuthError);
  assert.throws(() => verifyToken(SECRET, 'a.b'), AuthError);
  assert.throws(() => verifyToken(SECRET, 'a.b.c.d'), AuthError);
  // alg=none confusion attempt (unsigned)
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      roomId: 'r1',
      participantId: 'alice',
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) + 100,
    }),
  ).toString('base64url');
  assert.throws(
    () => verifyToken(SECRET, `${h}.${p}.`),
    (e: unknown) => e instanceof AuthError && e.code === 'unauthorized',
  );
});

test('auth: issueToken validates its inputs', () => {
  assert.throws(() => issueToken('', { roomId: 'r', participantId: 'p' }), TypeError);
  assert.throws(() => issueToken(SECRET, { roomId: '', participantId: 'p' }), TypeError);
  assert.throws(
    () => issueToken(SECRET, { roomId: 'r', participantId: 'p', role: 'superuser' as never }),
    TypeError,
  );
  assert.throws(
    () => issueToken(SECRET, { roomId: 'r', participantId: 'p', exp: 'soon' as never }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// HTTP guards
// ---------------------------------------------------------------------------

/** Boot a node server on an ephemeral port, run fn(base), always close. */
async function withServer(
  services: ReturnType<typeof createServices>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createNodeServer(services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

const jsonHeaders = { 'content-type': 'application/json' };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('auth http: /auth/token issues participant tokens (open issuance)', async () => {
  const services = createServices({ store: new InMemoryStore(), auth: { secret: SECRET } });
  await withServer(services, async (base) => {
    const res = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ roomId: 'r1', participantId: 'alice' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      token: string;
      roomId: string;
      participantId: string;
      role: string;
      exp: number;
    };
    assert.equal(body.roomId, 'r1');
    assert.equal(body.participantId, 'alice');
    assert.equal(body.role, 'participant');
    const claims = verifyToken(SECRET, body.token);
    assert.equal(claims.roomId, 'r1');
    assert.equal(claims.exp, body.exp);
  });
});

test('auth http: admin role (and guarded issuance) requires adminToken header', async () => {
  const services = createServices({
    store: new InMemoryStore(),
    auth: { secret: SECRET, adminToken: 'adm-1' },
  });
  await withServer(services, async (base) => {
    // participant issuance without the configured adminToken -> 401
    const noAdmin = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ roomId: 'r1', participantId: 'alice' }),
    });
    assert.equal(noAdmin.status, 401);
    assert.equal(
      ((await noAdmin.json()) as { error: { code: string } }).error.code,
      'unauthorized',
    );

    // admin role without adminToken -> 403
    const adminNoHeader = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ roomId: 'r1', participantId: 'root', role: 'admin' }),
    });
    assert.equal(adminNoHeader.status, 403);
    assert.equal(
      ((await adminNoHeader.json()) as { error: { code: string } }).error.code,
      'forbidden',
    );

    // admin role with a wrong adminToken -> 403
    const adminWrong = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: { ...jsonHeaders, adminToken: 'nope' },
      body: JSON.stringify({ roomId: 'r1', participantId: 'root', role: 'admin' }),
    });
    assert.equal(adminWrong.status, 403);

    // correct adminToken mints participant + admin tokens
    const admin = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: { ...jsonHeaders, adminToken: 'adm-1' },
      body: JSON.stringify({ roomId: 'r1', participantId: 'root', role: 'admin' }),
    });
    assert.equal(admin.status, 200);
    assert.equal(((await admin.json()) as { role: string }).role, 'admin');
    const participant = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: { ...jsonHeaders, adminToken: 'adm-1' },
      body: JSON.stringify({ roomId: 'r1', participantId: 'alice' }),
    });
    assert.equal(participant.status, 200);
  });
});

test('auth http: open issuance still forbids admin role when no adminToken configured', async () => {
  const services = createServices({ store: new InMemoryStore(), auth: { secret: SECRET } });
  await withServer(services, async (base) => {
    const res = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ roomId: 'r1', participantId: 'root', role: 'admin' }),
    });
    assert.equal(res.status, 403);
  });
});

test('auth http: /auth/token without auth config -> 501 auth_not_configured', async () => {
  const services = createServices({ store: new InMemoryStore() });
  await withServer(services, async (base) => {
    const res = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ roomId: 'r1', participantId: 'alice' }),
    });
    assert.equal(res.status, 501);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      'auth_not_configured',
    );
  });
});

test('auth http: join requires a valid bearer token (401 envelopes)', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  const services = createServices({ store, auth: { secret: SECRET } });
  await withServer(services, async (base) => {
    const join = (headers: Record<string, string>, participantId: string) =>
      fetch(`${base}/rooms/r1/join`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...headers },
        body: JSON.stringify({ participantId, sessionId: `s-${participantId}` }),
      });

    // no header -> 401 unauthorized
    const none = await join({}, 'alice');
    assert.equal(none.status, 401);
    assert.equal(((await none.json()) as { error: { code: string } }).error.code, 'unauthorized');

    // garbage token -> 401
    const garbage = await join(bearer('garbage'), 'alice');
    assert.equal(garbage.status, 401);

    // expired token -> 401 token_expired
    const expired = issueToken(SECRET, {
      roomId: 'r1',
      participantId: 'alice',
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    const expiredRes = await join(bearer(expired), 'alice');
    assert.equal(expiredRes.status, 401);
    assert.equal(
      ((await expiredRes.json()) as { error: { code: string } }).error.code,
      'token_expired',
    );

    // valid token -> 200
    const token = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });
    const ok = await join(bearer(token), 'alice');
    assert.equal(ok.status, 200);
  });
});

test('auth http: wrong-room token -> 403 forbidden on join and state', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  await createRoom(store, { roomId: 'r2' });
  const services = createServices({ store, auth: { secret: SECRET } });
  const token = issueToken(SECRET, { roomId: 'r2', participantId: 'alice' });
  await withServer(services, async (base) => {
    const join = await fetch(`${base}/rooms/r1/join`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...bearer(token) },
      body: JSON.stringify({ participantId: 'alice', sessionId: 's-a' }),
    });
    assert.equal(join.status, 403);
    assert.equal(((await join.json()) as { error: { code: string } }).error.code, 'forbidden');

    const state = await fetch(`${base}/rooms/r1/state`, { headers: bearer(token) });
    assert.equal(state.status, 403);
  });
});

test('auth http: tokens are identity-bound (cannot join/signal as someone else)', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  await joinRoom(store, 'r1', { participantId: 'alice', sessionId: 's-a' });
  const services = createServices({ store, auth: { secret: SECRET } });
  const aliceToken = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });
  await withServer(services, async (base) => {
    const joinAsBob = await fetch(`${base}/rooms/r1/join`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...bearer(aliceToken) },
      body: JSON.stringify({ participantId: 'bob', sessionId: 's-b' }),
    });
    assert.equal(joinAsBob.status, 403);
    assert.equal(((await joinAsBob.json()) as { error: { code: string } }).error.code, 'forbidden');

    const signalAsBob = await fetch(`${base}/rooms/r1/signal`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...bearer(aliceToken) },
      body: JSON.stringify({
        v: 1,
        type: 'chat',
        roomId: 'r1',
        senderId: 'bob',
        sessionId: 's-b',
        ts: Date.now(),
        seq: 1,
        payload: { text: 'hi' },
      }),
    });
    assert.equal(signalAsBob.status, 403);

    // ...but signaling as alice herself works
    const ok = await fetch(`${base}/rooms/r1/signal`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...bearer(aliceToken) },
      body: JSON.stringify({
        v: 1,
        type: 'chat',
        roomId: 'r1',
        senderId: 'alice',
        sessionId: 's-a',
        ts: Date.now(),
        seq: 1,
        payload: { text: 'hi' },
      }),
    });
    assert.equal(ok.status, 200);
  });
});

test('auth http: role enforcement — close/delete are admin-only', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  const services = createServices({ store, auth: { secret: SECRET } });
  const participant = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });
  const admin = issueToken(SECRET, { roomId: 'r1', participantId: 'root', role: 'admin' });
  await withServer(services, async (base) => {
    const closeAsParticipant = await fetch(`${base}/rooms/r1/close`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...bearer(participant) },
      body: '{}',
    });
    assert.equal(closeAsParticipant.status, 403);
    assert.equal(
      ((await closeAsParticipant.json()) as { error: { code: string } }).error.code,
      'forbidden',
    );

    const closeAsAdmin = await fetch(`${base}/rooms/r1/close`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...bearer(admin) },
      body: '{}',
    });
    assert.equal(closeAsAdmin.status, 200);
    assert.equal(((await closeAsAdmin.json()) as { room: { state: string } }).room.state, 'closed');

    const delAsParticipant = await fetch(`${base}/rooms/r1`, {
      method: 'DELETE',
      headers: bearer(participant),
    });
    assert.equal(delAsParticipant.status, 403);

    const delAsAdmin = await fetch(`${base}/rooms/r1`, {
      method: 'DELETE',
      headers: bearer(admin),
    });
    assert.equal(delAsAdmin.status, 200);
    assert.equal(((await delAsAdmin.json()) as { deleted: boolean }).deleted, true);

    // room is gone
    const state = await fetch(`${base}/rooms/r1/state`, { headers: bearer(admin) });
    assert.equal(state.status, 404);
  });
});

test('auth http: guarded routes (state/recordings/signal/leave) enforce tokens', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  await joinRoom(store, 'r1', { participantId: 'alice', sessionId: 's-a' });
  const services = createServices({ store, auth: { secret: SECRET } });
  const token = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });
  await withServer(services, async (base) => {
    // without token -> 401 across the guarded routes
    const state = await fetch(`${base}/rooms/r1/state`);
    assert.equal(state.status, 401);
    const recordings = await fetch(`${base}/rooms/r1/recordings`);
    assert.equal(recordings.status, 401);
    const signal = await fetch(`${base}/rooms/r1/signal`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        v: 1,
        type: 'chat',
        roomId: 'r1',
        senderId: 'alice',
        sessionId: 's-a',
        ts: Date.now(),
        seq: 1,
        payload: { text: 'hi' },
      }),
    });
    assert.equal(signal.status, 401);
    const leave = await fetch(`${base}/rooms/r1/leave`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ participantId: 'alice' }),
    });
    assert.equal(leave.status, 401);

    // with the token they all succeed
    assert.equal((await fetch(`${base}/rooms/r1/state`, { headers: bearer(token) })).status, 200);
    assert.equal(
      (await fetch(`${base}/rooms/r1/recordings`, { headers: bearer(token) })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/rooms/r1/signal`, {
          method: 'POST',
          headers: { ...jsonHeaders, ...bearer(token) },
          body: JSON.stringify({
            v: 1,
            type: 'chat',
            roomId: 'r1',
            senderId: 'alice',
            sessionId: 's-a',
            ts: Date.now(),
            seq: 2,
            payload: { text: 'hi' },
          }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/rooms/r1/leave`, {
          method: 'POST',
          headers: { ...jsonHeaders, ...bearer(token) },
          body: JSON.stringify({ participantId: 'alice' }),
        })
      ).status,
      200,
    );
  });
});

test('auth http: open mode keeps legacy behavior (no tokens required)', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  const services = createServices({ store });
  await withServer(services, async (base) => {
    const join = await fetch(`${base}/rooms/r1/join`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ participantId: 'alice', sessionId: 's-a' }),
    });
    assert.equal(join.status, 200);
    const state = await fetch(`${base}/rooms/r1/state`);
    assert.equal(state.status, 200);
    // admin routes exist but are open too (no auth configured)
    const close = await fetch(`${base}/rooms/r1/close`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    assert.equal(close.status, 200);
  });
});

// ---------------------------------------------------------------------------
// WebSocket guards
// ---------------------------------------------------------------------------

interface TestServer {
  base: string;
  wsUrl(roomId: string, token?: string): string;
  close(): Promise<void>;
}

async function withRelayServer(
  services: ReturnType<typeof createServices>,
  fn: (srv: TestServer) => Promise<void>,
): Promise<void> {
  const server = createNodeServer(services);
  const relay = attachWebSocketRelay(server, services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({
      base,
      wsUrl: (roomId, token) =>
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}${token ? `&token=${token}` : ''}`,
      close: async () => {
        await relay.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    });
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

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

function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

test('auth ws: join without a token is rejected (error envelope + close 4401)', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  const services = createServices({ store, auth: { secret: SECRET } });
  await withRelayServer(services, async (srv) => {
    const ws = await openSocket(srv.wsUrl('r1'));
    ws.send(
      JSON.stringify(createEnvelope('join', { roomId: 'r1', senderId: 'alice', sessionId: 's-a' })),
    );
    const msg = (await nextMessage(ws)) as Envelope;
    assert.equal(msg.type, 'error');
    assert.equal((msg.payload as { code: string }).code, 'unauthorized');
    const close = await nextClose(ws);
    assert.equal(close.code, 4401);
  });
});

test('auth ws: bad/expired/wrong-room tokens are rejected; valid token joins', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  await createRoom(store, { roomId: 'r2' });
  const services = createServices({ store, auth: { secret: SECRET } });

  const expired = issueToken(SECRET, {
    roomId: 'r1',
    participantId: 'alice',
    exp: Math.floor(Date.now() / 1000) - 5,
  });
  const wrongRoom = issueToken(SECRET, { roomId: 'r2', participantId: 'alice' });
  const valid = issueToken(SECRET, { roomId: 'r1', participantId: 'alice' });
  const otherIdentity = issueToken(SECRET, { roomId: 'r1', participantId: 'bob' });

  await withRelayServer(services, async (srv) => {
    // expired -> unauthorized envelope + close
    const ws1 = await openSocket(srv.wsUrl('r1', expired));
    ws1.send(
      JSON.stringify(createEnvelope('join', { roomId: 'r1', senderId: 'alice', sessionId: 's-a' })),
    );
    const err1 = (await nextMessage(ws1)) as Envelope;
    assert.equal((err1.payload as { code: string }).code, 'token_expired');
    assert.equal((await nextClose(ws1)).code, 4401);

    // wrong room -> forbidden envelope + close
    const ws2 = await openSocket(srv.wsUrl('r1', wrongRoom));
    ws2.send(
      JSON.stringify(createEnvelope('join', { roomId: 'r1', senderId: 'alice', sessionId: 's-a' })),
    );
    const err2 = (await nextMessage(ws2)) as Envelope;
    assert.equal((err2.payload as { code: string }).code, 'forbidden');
    assert.equal((await nextClose(ws2)).code, 4401);

    // token bound to bob cannot join as alice
    const ws3 = await openSocket(srv.wsUrl('r1', otherIdentity));
    ws3.send(
      JSON.stringify(createEnvelope('join', { roomId: 'r1', senderId: 'alice', sessionId: 's-a' })),
    );
    const err3 = (await nextMessage(ws3)) as Envelope;
    assert.equal((err3.payload as { code: string }).code, 'forbidden');
    await nextClose(ws3);

    // valid token joins and gets the joined ack
    const ws4 = await openSocket(srv.wsUrl('r1', valid));
    ws4.send(
      JSON.stringify(createEnvelope('join', { roomId: 'r1', senderId: 'alice', sessionId: 's-a' })),
    );
    const joined = (await nextMessage(ws4)) as { type: string; roomId: string };
    assert.equal(joined.type, 'joined');
    assert.equal(joined.roomId, 'r1');
    ws4.close();
  });
});

test('auth ws: open mode (no auth) ignores the token param and joins fine', async () => {
  const store = new InMemoryStore();
  await createRoom(store, { roomId: 'r1' });
  const services = createServices({ store });
  await withRelayServer(services, async (srv) => {
    const ws = await openSocket(srv.wsUrl('r1', 'whatever'));
    ws.send(
      JSON.stringify(createEnvelope('join', { roomId: 'r1', senderId: 'alice', sessionId: 's-a' })),
    );
    const joined = (await nextMessage(ws)) as { type: string };
    assert.equal(joined.type, 'joined');
    ws.close();
  });
});
