/**
 * L0 wire-rule conformance — schema.json rules "unknown `type` values are
 * ignored + logged (clients MUST NOT fail decode)", "unknown fields are
 * ignored", and required-field validation, mirroring:
 *
 *  - Kotlin `EnvelopeSerializationTest` (`unknown envelope types are ignored
 *    and logged instead of throwing`, `unknown fields are ignored`,
 *    `missing required envelope fields throw`, `v != 1` handling)
 *  - Kotlin `TransportToleranceTest` (a transport loop must skip an
 *    unknown-type frame and still deliver valid ones without failing)
 *  - Dart `protocol_roundtrip_test.dart` "Envelope validation" group
 *
 * protocol/types.ts exports no tolerant decoder; its exported structural guard
 * `isEnvelope` IS the tolerant reader primitive: unknown types return false and
 * callers filter them out instead of throwing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFixture, loadFixture } from './helpers.ts';
import { createEnvelope, isEnvelope, PROTOCOL_VERSION, type Envelope } from '../types.ts';

/** Unknown-type frame used by the Kotlin suites ("teleport"). */
const TELEPORT_FRAME =
  '{"v":1,"type":"teleport","roomId":"room-42","senderId":"user-ada",' +
  '"sessionId":"sess-abc-0001","ts":1786000007000,"seq":14,"payload":{}}';

/** Unknown-type frame used by the Dart suite ("future.message"). */
const FUTURE_MESSAGE_FRAME =
  '{"v":1,"type":"future.message","roomId":"r","senderId":"s","sessionId":"sess",' +
  '"ts":1,"seq":0,"payload":{"anything":true}}';

function parseFrame(text: string): Record<string, unknown> {
  // must never throw on a well-formed JSON object, whatever the type says
  const parsed: unknown = JSON.parse(text);
  assert.equal(typeof parsed, 'object');
  return parsed as Record<string, unknown>;
}

// --- strict guard rejects what the schema rejects ---------------------------

test('isEnvelope returns false for unknown envelope types', () => {
  assert.equal(isEnvelope(parseFrame(TELEPORT_FRAME)), false, 'teleport');
  assert.equal(isEnvelope(parseFrame(FUTURE_MESSAGE_FRAME)), false, 'future.message');
});

test('isEnvelope returns false when v differs from PROTOCOL_VERSION', () => {
  const e = { ...loadFixture('ping'), v: PROTOCOL_VERSION + 1 };
  assert.equal(isEnvelope(e), false);
  const ancient = { ...loadFixture('ping'), v: 99 };
  assert.equal(isEnvelope(ancient), false); // kotlin: reports protocol-version error
});

test('isEnvelope returns false when required envelope fields are missing', () => {
  for (const key of ['v', 'type', 'roomId', 'senderId', 'sessionId', 'ts', 'seq']) {
    const broken: Record<string, unknown> = { ...loadFixture('chat') };
    delete broken[key];
    assert.equal(isEnvelope(broken), false, `missing ${key} must be rejected`);
  }
});

test('isEnvelope returns false for wrongly-typed header fields', () => {
  const base: Record<string, unknown> = { ...loadFixture('chat') };
  assert.equal(isEnvelope({ ...base, roomId: 42 }), false, 'numeric roomId');
  assert.equal(isEnvelope({ ...base, senderId: null }), false, 'null senderId');
  assert.equal(isEnvelope({ ...base, ts: '1786000003500' }), false, 'string ts');
  // NOTE: isEnvelope enforces the schema's *types* only; range rules such as
  // "seq >= 0" / "ts integer" hold for every canonical fixture but are not
  // part of the structural guard (see envelope-conformance header assertions).
});

// --- tolerant reader path skips unknown frames -------------------------------

test('a reader filtering on isEnvelope skips unknown types and delivers valid ones', () => {
  const chatFrame = JSON.stringify(loadFixture('chat'));
  // mirrors Kotlin TransportToleranceTest: unknown frame first, valid after
  const wireFrames = [TELEPORT_FRAME, chatFrame];
  const delivered = wireFrames.map(parseFrame).filter(isEnvelope);

  assert.equal(delivered.length, 1, 'unknown-type frame skipped, valid one delivered');
  const [chatEnvelope] = delivered;
  assert.ok(chatEnvelope, 'valid envelope delivered');
  const chat = chatEnvelope.payload as { text?: string };
  assert.equal(chat.text, 'hello room');
});

test('known envelopes flow through the tolerant path unchanged', () => {
  for (const name of ['join', 'offer', 'ice', 'chat', 'error', 'ping']) {
    const decoded: Envelope | undefined = (() => {
      const raw = parseFrame(JSON.stringify(loadFixture(name)));
      return isEnvelope(raw) ? raw : undefined;
    })();
    assert.ok(decoded, `${name}: known type must pass the guard`);
    assert.deepEqual(decoded, loadFixture(name));
  }
});

// --- forward compatibility: unknown fields -----------------------------------

test('unknown fields inside a payload are ignored', () => {
  // kotlin: {"text":"hi","futureField":42} decodes to text "hi"
  const raw = parseFrame(
    '{"v":1,"type":"chat","roomId":"r","senderId":"a","sessionId":"s","ts":1,"seq":0,' +
      '"payload":{"text":"hi","futureField":42}}',
  );
  assert.equal(isEnvelope(raw), true, 'unknown payload fields do not break decode');
  const chat = raw['payload'] as { text?: string } & Record<string, unknown>;
  assert.equal(chat.text, 'hi');
  assert.equal(chat['futureField'], 42); // preserved verbatim by the TS mirror
});

test('unknown fields at the envelope level are tolerated', () => {
  // dart: traceId survives decode without failing validation
  const raw = parseFrame(
    '{"v":1,"type":"ping","roomId":"r","senderId":"s","sessionId":"sess","ts":1,"seq":0,' +
      '"traceId":"abc"}',
  );
  assert.equal(isEnvelope(raw), true, 'unknown envelope fields do not break decode');
  assert.equal(raw.traceId, 'abc'); // additive changes stay non-breaking
});

// --- glare polarity rule ------------------------------------------------------

test('glare polarity: polite = selfId < remoteId over canonical fixture identities', () => {
  // schema.json: every binding derives polite via lexicographic senderId order;
  // pinned here like the Kotlin suite against the fixture peers.
  const isPolite = (selfId: string, remoteId: string): boolean => selfId < remoteId;
  assert.equal(isPolite('user-ada', 'user-bob'), true);
  assert.equal(isPolite('user-bob', 'user-ada'), false);
  assert.equal(isPolite('user-ada', 'user-ada'), false, 'never polite with itself');

  // the broadcast/targeted join fixtures actually use those two identities
  const ada = decodeFixture('join');
  const bob = decodeFixture('join-targeted');
  assert.equal(ada.senderId, 'user-ada');
  assert.equal(bob.senderId, 'user-bob');
  assert.ok(ada.senderId < bob.senderId, 'fixture identities order ada < bob');
});

// --- builder defaults ---------------------------------------------------------

test('createEnvelope fills ts/seq defaults and stamps PROTOCOL_VERSION', () => {
  const before = Date.now();
  const env = createEnvelope('ping', { roomId: 'room-42', senderId: 'user-ada', sessionId: 's' });
  const after = Date.now();
  assert.equal(env.v, PROTOCOL_VERSION);
  assert.equal(env.seq, 0);
  assert.ok(env.ts >= before && env.ts <= after, 'default ts is now (epoch ms)');
  assert.equal(env.type, 'ping');
  assert.equal(Object.hasOwn(env, 'payload'), false, 'no payload key unless provided');
});
