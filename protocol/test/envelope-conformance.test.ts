/**
 * L0 envelope conformance — mirrors the Kotlin
 * `EnvelopeSerializationTest` header/round-trip/targeted/ping-pong assertions
 * and the Dart `protocol_roundtrip_test.dart` "Envelope round-trip" group,
 * over the same canonical fixtures in `protocol/fixtures/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import {
  BROADCAST_FIXTURE_NAMES,
  FIXTURE_NAMES,
  TARGETED_FIXTURE_NAMES,
  UNICAST_CAPABLE_TYPES,
  decodeFixture,
  fixtureType,
  fixturesDir,
  loadFixture,
  loadFixtureText,
  rebuildEnvelope,
} from './helpers.ts';
import { isEnvelope, PROTOCOL_VERSION } from '../types.ts';

// --- canonical corpus ------------------------------------------------------

test('fixture directory contains exactly the canonical Kotlin/Dart fixture list', () => {
  const onDisk = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  assert.deepEqual(onDisk, [...FIXTURE_NAMES].sort());
});

test('every canonical fixture parses and satisfies the Envelope guard', () => {
  for (const name of FIXTURE_NAMES) {
    assert.ok(isEnvelope(loadFixture(name)), `${name} does not satisfy the Envelope guard`);
  }
});

// --- per-fixture envelope headers (Kotlin "correct headers", Dart headers) --

test('every fixture carries the canonical envelope headers', () => {
  for (const name of FIXTURE_NAMES) {
    const e = loadFixture(name);
    const decoded = decodeFixture(name);
    assert.equal(e['v'], PROTOCOL_VERSION, `${name}: v`);
    assert.equal(decoded.type, fixtureType(name), `${name}: type matches its filename`);
    assert.equal(e['roomId'], 'room-42', `${name}: roomId`);
    assert.match(String(e['senderId']), /^user-/, `${name}: senderId set`);
    assert.match(String(e['sessionId']), /^sess-/, `${name}: sessionId set`);
    const seq = e['seq'];
    assert.equal(typeof seq, 'number', `${name}: seq is a number`);
    assert.ok(Number.isInteger(seq), `${name}: seq is an integer`);
    assert.ok((seq as number) >= 0, `${name}: seq is 0-based (>= 0)`);
    // schema.json: ts is an integer (epoch milliseconds)
    assert.ok(Number.isInteger(e['ts']), `${name}: ts is an integer (epoch ms)`);
    assert.ok((e['ts'] as number) > 0, `${name}: ts is a positive epoch-ms number`);
  }
});

// --- round-trip -------------------------------------------------------------

test('createEnvelope reconstructs every fixture losslessly', () => {
  for (const name of FIXTURE_NAMES) {
    const source = loadFixture(name);
    const rebuilt = rebuildEnvelope(source);
    assert.deepEqual(
      rebuilt,
      source,
      `${name}: createEnvelope reconstruction must deep-equal the fixture`,
    );
    assert.ok(isEnvelope(rebuilt), `${name}: reconstruction satisfies the Envelope guard`);
    // object round-trip stability (Kotlin: decode(encode(decoded)) == decoded)
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(source)));
  }
});

test('re-encoded ping/pong keep no payload key on the wire', () => {
  for (const name of ['ping', 'pong']) {
    const rebuilt = rebuildEnvelope(loadFixture(name));
    assert.equal(
      JSON.stringify(rebuilt).includes('"payload"'),
      false,
      `${name}: re-encode omits payload key`,
    );
  }
});

// --- unicast / broadcast ----------------------------------------------------

test('targeted fixtures carry targetSenderId and broadcast fixtures do not', () => {
  for (const name of FIXTURE_NAMES) {
    const raw = loadFixture(name);
    if (TARGETED_FIXTURE_NAMES.includes(name)) {
      assert.equal(Object.hasOwn(raw, 'targetSenderId'), true, `${name}: has targetSenderId key`);
      assert.equal(decodeFixture(name).targetSenderId, 'user-ada', `${name}: targetSenderId`);
    } else {
      assert.equal(Object.hasOwn(raw, 'targetSenderId'), false, `${name}: no targetSenderId key`);
      assert.equal(decodeFixture(name).targetSenderId, undefined, `${name}: no targetSenderId`);
    }
  }
});

test('-targeted suffix only appears on unicast-capable signal types', () => {
  const unicast = new Set(UNICAST_CAPABLE_TYPES);
  for (const name of TARGETED_FIXTURE_NAMES) {
    assert.ok(unicast.has(fixtureType(name)), `${name}: -targeted on a non-unicast type`);
  }
  for (const name of BROADCAST_FIXTURE_NAMES) {
    assert.ok(!name.endsWith('-targeted'), `${name}: broadcast fixture must not be targeted`);
  }
});

// --- wire rule: ping/pong omit the payload key ------------------------------

test('ping and pong omit the payload key on the wire', () => {
  for (const name of ['ping', 'pong']) {
    const text = loadFixtureText(name);
    assert.equal(text.includes('"payload"'), false, `${name}: fixture has no payload key`);
    const parsed = loadFixture(name);
    assert.equal(Object.hasOwn(parsed, 'payload'), false, `${name}: parsed object has no payload`);
  }
});

test('non-ping/pong fixtures carry a payload object', () => {
  for (const name of FIXTURE_NAMES) {
    if (name === 'ping' || name === 'pong') continue;
    const parsed = loadFixture(name);
    assert.equal(typeof parsed['payload'], 'object', `${name}: payload present`);
    assert.ok(parsed['payload'] !== null, `${name}: payload is a non-null object`);
  }
});
