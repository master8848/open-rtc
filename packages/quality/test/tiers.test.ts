import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUALITY_TIERS,
  AUDIO_ONLY_TIER_ID,
  findTier,
  nextHigherTier,
  nextLowerTier,
  tierIndex,
} from '../src/tiers.ts';

test('ladder is ordered high -> low and audio-only is last', () => {
  assert.deepEqual(
    DEFAULT_QUALITY_TIERS.map((t) => t.id),
    ['1080p@30', '720p@30', '480p@30', '360p@15', 'audio-only'],
  );
  assert.equal(DEFAULT_QUALITY_TIERS[4]?.audioOnly, true);
});

test('findTier / tierIndex', () => {
  assert.equal(findTier(DEFAULT_QUALITY_TIERS, '720p@30')?.maxBitrateKbps, 1200);
  assert.equal(tierIndex(DEFAULT_QUALITY_TIERS, '1080p@30'), 0);
  assert.equal(tierIndex(DEFAULT_QUALITY_TIERS, AUDIO_ONLY_TIER_ID), 4);
  assert.equal(tierIndex(DEFAULT_QUALITY_TIERS, 'nope'), -1);
});

test('nextLowerTier / nextHigherTier', () => {
  assert.equal(nextLowerTier(DEFAULT_QUALITY_TIERS, '1080p@30')?.id, '720p@30');
  assert.equal(nextHigherTier(DEFAULT_QUALITY_TIERS, 'audio-only')?.id, '360p@15');
  assert.equal(nextLowerTier(DEFAULT_QUALITY_TIERS, 'audio-only'), undefined);
  assert.equal(nextHigherTier(DEFAULT_QUALITY_TIERS, '1080p@30'), undefined);
});

test('tier fields are sane', () => {
  for (const tier of DEFAULT_QUALITY_TIERS) {
    assert.ok(tier.maxBitrateKbps >= 0);
    assert.ok(tier.requiredBitrateKbps >= 0);
    assert.ok(tier.maxFramerate >= 0);
  }
  // Bitrate strictly decreases down the ladder.
  for (let i = 1; i < DEFAULT_QUALITY_TIERS.length; i++) {
    assert.ok(
      DEFAULT_QUALITY_TIERS[i]!.maxBitrateKbps <= DEFAULT_QUALITY_TIERS[i - 1]!.maxBitrateKbps,
    );
  }
});
