/**
 * L0 schema cross-check — loads `protocol/schema.json` (the single source of
 * truth) and pins the fixture corpus and the TS mirror (`../types.ts`) to it:
 *
 *  - the fixture corpus covers every envelope type defined in the schema and
 *    no fixture uses a type absent from the schema (Kotlin: "fixtures cover
 *    every schema envelope type"; Dart equivalent)
 *  - the schema's `allOf` payload mapping matches the TS `MessagePayloadMap`
 *  - the wire rules encoded in the fixtures themselves: `seq` is monotonic per
 *    sender+session starting at 0, `ts` strictly increasing (schema.json seq
 *    description + protocol/fixtures/README.md "seq 0-based monotonic")
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_NAMES,
  UNICAST_CAPABLE_TYPES,
  decodeFixture,
  fixturesDir,
  loadFixture,
} from './helpers.ts';
import {
  MESSAGE_TYPES,
  PRESENCE_STATES,
  PROTOCOL_VERSION,
  QUALITY_WARNING_DIRECTIONS,
  QUALITY_WARNING_REASONS,
  SCREEN_SHARE_ACTIONS,
  SFU_ACTIONS,
  SFU_KINDS,
} from '../types.ts';

const schemaPath = path.join(fixturesDir, '..', 'schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  required: string[];
  properties: {
    v: { const: number };
    type: { enum: string[] };
    targetSenderId: { description: string };
  };
  allOf: Array<{
    if?: { properties?: { type?: { const?: string } } };
    then?: { properties?: { payload?: { $ref?: string } } };
  }>;
  definitions: Record<string, unknown>;
};

/** filename-derived envelope types for the whole corpus. */
function corpusTypes(): Set<string> {
  return new Set(
    FIXTURE_NAMES.map((name) => name.replace(/\.json$/, '').replace(/-targeted$/, '')),
  );
}

// --- schema ↔ types.ts mirror ----------------------------------------------

test('schema.json v const equals PROTOCOL_VERSION', () => {
  assert.equal(schema.properties.v.const, PROTOCOL_VERSION);
});

test('schema.json type enum equals MESSAGE_TYPES', () => {
  assert.deepEqual([...MESSAGE_TYPES].sort(), [...schema.properties.type.enum].sort());
});

test('schema.json required fields match the EnvelopeBase contract', () => {
  assert.deepEqual(schema.required, ['v', 'type', 'roomId', 'senderId', 'sessionId', 'ts', 'seq']);
});

test('schema.json if/then payload refs match the MessagePayloadMap definitions', () => {
  // type → payload definition name, derived from the schema's own allOf branches
  const expectedMapping: Record<string, string> = {
    join: 'JoinPayload',
    leave: 'LeavePayload',
    offer: 'OfferPayload',
    answer: 'OfferPayload',
    ice: 'IcePayload',
    presence: 'PresencePayload',
    reaction: 'ReactionPayload',
    chat: 'ChatPayload',
    'screen-share': 'ScreenSharePayload',
    'quality-warning': 'QualityWarningPayload',
    sfu: 'SfuPayload',
    error: 'ErrorPayload',
  };
  const actualMapping: Record<string, string> = {};
  for (const branch of schema.allOf) {
    const type = branch.if?.properties?.type?.const;
    const ref = branch.then?.properties?.payload?.$ref;
    if (!type || !ref) continue;
    const definitionName = ref.replace(/^#\/definitions\//, '');
    assert.ok(
      Object.hasOwn(schema.definitions, definitionName),
      `${definitionName} must exist in schema definitions`,
    );
    actualMapping[type] = definitionName;
  }
  assert.deepEqual(actualMapping, expectedMapping);

  // ping/pong carry no payload definition (wire rule: no payload key at all)
  assert.equal(Object.hasOwn(actualMapping, 'ping'), false);
  assert.equal(Object.hasOwn(actualMapping, 'pong'), false);
  const mappedTypes = new Set(Object.keys(actualMapping));
  for (const type of MESSAGE_TYPES) {
    if (type === 'ping' || type === 'pong') continue;
    assert.ok(mappedTypes.has(type), `${type} must have a payload definition`);
  }
});

test('schema enum vocabularies match the exported TS constants', () => {
  const joinDef = schema.definitions['JoinPayload'] as {
    properties: { capabilities: { properties: Record<string, unknown> } };
  };
  const presenceDef = schema.definitions['PresencePayload'] as {
    properties: { state: { enum: string[] } };
  };
  const reactionDef = schema.definitions['ReactionPayload'] as {
    properties: Record<string, unknown>;
  };
  const screenShareDef = schema.definitions['ScreenSharePayload'] as {
    properties: { action: { enum: string[] } };
  };
  const qualityDef = schema.definitions['QualityWarningPayload'] as {
    properties: { reason: { enum: string[] }; direction: { enum: string[] } };
  };
  const sfuDef = schema.definitions['SfuPayload'] as {
    properties: { action: { enum: string[] }; kind: { enum: string[] } };
  };

  assert.deepEqual(presenceDef.properties.state.enum, [...PRESENCE_STATES]);
  assert.deepEqual(screenShareDef.properties.action.enum, [...SCREEN_SHARE_ACTIONS]);
  assert.deepEqual(qualityDef.properties.reason.enum, [...QUALITY_WARNING_REASONS]);
  assert.deepEqual(qualityDef.properties.direction.enum, [...QUALITY_WARNING_DIRECTIONS]);
  assert.deepEqual(sfuDef.properties.action.enum, [...SFU_ACTIONS]);
  assert.deepEqual(sfuDef.properties.kind.enum, [...SFU_KINDS]);
  // ReactionPayload has an optional targetSenderId property (payload-level)
  assert.equal(Object.hasOwn(reactionDef.properties, 'targetSenderId'), true);
  assert.equal(Object.hasOwn(joinDef.properties.capabilities.properties, 'simulcast'), true);
});

test('schema targetSenderId doc lists exactly the unicast-capable signal types', () => {
  const listed = schema.properties.targetSenderId.description.match(/\(([^)]*\/[^)]*)\)/)?.[1];
  assert.ok(listed, 'description must enumerate the unicast types');
  assert.deepEqual(
    listed.split('/').map((s) => s.trim()),
    [...UNICAST_CAPABLE_TYPES],
  );
});

// --- fixture corpus coverage -------------------------------------------------

test('no fixture uses a type absent from the schema enum', () => {
  const schemaTypes = new Set(schema.properties.type.enum);
  for (const name of FIXTURE_NAMES) {
    const type = name.replace(/-targeted$/, '');
    assert.ok(schemaTypes.has(type), `${name}: type "${type}" is not in the schema enum`);
    assert.equal(loadFixture(name)['type'], type, `${name}: envelope type matches its filename`);
  }
});

test('fixture corpus covers every message type defined in the schema', () => {
  assert.deepEqual([...corpusTypes()].sort(), [...schema.properties.type.enum].sort());
});

// --- seq/ts semantics encoded in the fixture corpus ---------------------------

test('seq is monotonic per sender per session, starting at 0, with ts increasing', () => {
  // schema.json: "seq is monotonic per sender per sessionId, starting at 0";
  // protocol/fixtures/README.md: "seq 0-based monotonic". Group by
  // (senderId, sessionId) — ada/user sess-abc-0001 vs bob/user sess-xyz-0002.
  const sessions = new Map<string, Array<{ ts: number; seq: number; name: string }>>();
  for (const name of FIXTURE_NAMES) {
    const e = decodeFixture(name);
    const key = `${e.senderId}@${e.sessionId}`;
    const list = sessions.get(key) ?? [];
    list.push({ ts: e.ts, seq: e.seq, name });
    sessions.set(key, list);
  }

  assert.equal(sessions.size, 2, 'the canonical corpus has exactly two sender sessions');
  for (const [key, envelopes] of sessions) {
    const ordered = [...envelopes].sort((a, b) => a.ts - b.ts);
    assert.equal(ordered[0]?.seq, 0, `${key}: first seq is 0`);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(
        ordered[i]!.ts > ordered[i - 1]!.ts,
        `${key}: ${ordered[i]!.name} ts increases after ${ordered[i - 1]!.name}`,
      );
      assert.equal(
        ordered[i]!.seq,
        ordered[i - 1]!.seq + 1,
        `${key}: ${ordered[i]!.name} seq increments by 1`,
      );
    }
  }
});
