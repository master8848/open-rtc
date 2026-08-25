/**
 * Shared fixture-loading utilities for the TS L0 conformance suite.
 *
 * Mirrors the canonical fixture lists hardcoded in the Kotlin
 * (`EnvelopeSerializationTest.fixtureNames`) and Dart
 * (`protocol_roundtrip_test.dart` `fixtureNames`) L0 suites: adding a fixture
 * to `protocol/fixtures/` requires extending every binding's list (see
 * protocol/fixtures/README.md "Adding a type").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createEnvelope,
  isEnvelope,
  MESSAGE_TYPES,
  type Envelope,
  type MessagePayloadMap,
  type MessageType,
} from '../types.ts';

export const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

/** Every canonical fixture name (protocol/fixtures, without the .json suffix). */
export const FIXTURE_NAMES: readonly string[] = [
  'join',
  'leave',
  'offer',
  'answer',
  'ice',
  'presence',
  'reaction',
  'chat',
  'screen-share',
  'quality-warning',
  'sfu',
  'transcript',
  'error',
  'ping',
  'pong',
  'join-targeted',
  'leave-targeted',
  'offer-targeted',
  'answer-targeted',
  'ice-targeted',
  'presence-targeted',
  'reaction-targeted',
  'chat-targeted',
];

/** Fixture names for room-broadcast envelopes (no targetSenderId key). */
export const BROADCAST_FIXTURE_NAMES = FIXTURE_NAMES.filter((n) => !n.endsWith('-targeted'));

/** Fixture names for unicast envelopes (targetSenderId: "user-ada"). */
export const TARGETED_FIXTURE_NAMES = FIXTURE_NAMES.filter((n) => n.endsWith('-targeted'));

/**
 * The signal types schema.json allows to carry `targetSenderId`
 * (schema.json `properties.targetSenderId.description`).
 */
export const UNICAST_CAPABLE_TYPES: readonly MessageType[] = [
  'join',
  'leave',
  'offer',
  'answer',
  'ice',
  'presence',
  'reaction',
  'chat',
];

/** filename → envelope type ("foo-targeted" → "foo"), mirroring Kotlin `typeFor`. */
export function fixtureType(name: string): MessageType {
  const base = name.replace(/\.json$/, '').replace(/-targeted$/, '');
  if (!(MESSAGE_TYPES as readonly string[]).includes(base)) {
    throw new Error(`no MessageType for fixture ${name}`);
  }
  return base as MessageType;
}

const fixtureCache = new Map<string, Record<string, unknown>>();

/** Parse a canonical fixture into its raw JSON object (fs-backed, like Dart/Kotlin). */
export function loadFixture(name: string): Record<string, unknown> {
  const cached = fixtureCache.get(name);
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  > | null;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`fixture ${name} is not a JSON object`);
  }
  fixtureCache.set(name, parsed);
  return parsed;
}

/** Raw fixture bytes (for wire-format assertions such as ping/pong payload omission). */
export function loadFixtureText(name: string): string {
  return readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');
}

/** Load a fixture and narrow it through the shared structural guard. */
export function decodeFixture(name: string): Envelope {
  const envelope = loadFixture(name);
  if (!isEnvelope(envelope)) {
    throw new Error(`fixture ${name} does not satisfy the Envelope structural guard`);
  }
  return envelope;
}

/**
 * Rebuild a parsed envelope through `createEnvelope`, proving the exported
 * builder can express every canonical document byte-for-byte (the TS analogue
 * of the Kotlin "re-encode == fixture bytes" and Dart "fromJson -> toJson is
 * lossless" checks; key order is irrelevant, deep equality is asserted).
 */
export function rebuildEnvelope(envelope: Record<string, unknown>): Envelope {
  return createEnvelope(fixtureType(String(envelope['type'])), {
    roomId: envelope['roomId'] as string,
    senderId: envelope['senderId'] as string,
    sessionId: envelope['sessionId'] as string,
    ts: envelope['ts'] as number,
    seq: envelope['seq'] as number,
    ...(envelope['targetSenderId'] === undefined
      ? {}
      : { targetSenderId: envelope['targetSenderId'] as string }),
    ...(envelope['payload'] === undefined
      ? {}
      : { payload: envelope['payload'] as MessagePayloadMap[MessageType] }),
  });
}
