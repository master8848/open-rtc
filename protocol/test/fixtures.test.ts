/**
 * L0 protocol conformance for TS — mirrors the Kotlin/Dart fixture suites.
 *
 * Every language implementation must read the same canonical fixtures in
 * `protocol/fixtures/` and agree on their meaning. This suite is the TS side
 * of that contract (see docs/testing.md — L0 layer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isEnvelope, PROTOCOL_VERSION } from '../types.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

test('fixture corpus exists', () => {
  assert.ok(
    fixtureFiles.length >= 20,
    `expected a real fixture corpus, got ${fixtureFiles.length}`,
  );
});

test('every canonical fixture parses and satisfies the Envelope shape', () => {
  for (const file of fixtureFiles) {
    const raw = readFileSync(path.join(fixturesDir, file), 'utf8');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(
      isEnvelope(envelope),
      true,
      `${file} does not satisfy the Envelope structural guard`,
    );
    assert.equal(envelope['v'], PROTOCOL_VERSION, `${file} has an unexpected protocol version`);
  }
});

test('fixture filenames map to known envelope types', () => {
  const KNOWN_TYPES = new Set([
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
  ]);
  for (const file of fixtureFiles) {
    const base = file.replace(/\.json$/, '');
    const type = base.includes('-targeted') ? base.replace(/-targeted$/, '') : base;
    assert.ok(KNOWN_TYPES.has(type), `${file} implies unknown type "${type}"`);
  }
});
