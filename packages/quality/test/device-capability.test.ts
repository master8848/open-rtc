import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceCapability,
  computeDeviceScore,
  initialTierForScore,
} from '../src/device-capability.ts';
import { DEFAULT_QUALITY_TIERS } from '../src/tiers.ts';

test('computeDeviceScore: powerful desktop scores high, weak mobile low', () => {
  const desktop = computeDeviceScore({
    hardwareConcurrency: 16,
    deviceMemory: 32,
    mobile: false,
    screenWidth: 2560,
    screenHeight: 1440,
  });
  const weakMobile = computeDeviceScore({
    hardwareConcurrency: 2,
    deviceMemory: 2,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  assert.ok(desktop >= 0.8, `desktop=${desktop}`);
  assert.ok(weakMobile <= 0.5, `weakMobile=${weakMobile}`);
});

test('fromInput produces a wire-valid DeviceProfile', () => {
  const cap = DeviceCapability.fromInput({
    hardwareConcurrency: 8,
    deviceMemory: 16,
    mobile: false,
    screenWidth: 1920,
    screenHeight: 1080,
    platform: 'browser',
  });
  assert.equal(cap.profile.hardwareConcurrency, 8);
  assert.equal(cap.profile.mobile, false);
  assert.equal(cap.profile.deviceMemory, 16);
  assert.equal(cap.profile.platform, 'browser');
});

test('initialTier thresholds', () => {
  assert.equal(initialTierForScore(0.9, DEFAULT_QUALITY_TIERS).id, '1080p@30');
  assert.equal(initialTierForScore(0.6, DEFAULT_QUALITY_TIERS).id, '720p@30');
  assert.equal(initialTierForScore(0.4, DEFAULT_QUALITY_TIERS).id, '480p@30');
  assert.equal(initialTierForScore(0.25, DEFAULT_QUALITY_TIERS).id, '360p@15');
  assert.equal(initialTierForScore(0.1, DEFAULT_QUALITY_TIERS).id, 'audio-only');
});

test('initialTier caps by screen resolution', () => {
  const cap = DeviceCapability.fromInput({
    hardwareConcurrency: 16,
    deviceMemory: 32,
    mobile: false,
    screenWidth: 1280,
    screenHeight: 720,
  });
  // Device score would allow 1080p, but a 720p screen caps at 720p.
  assert.equal(cap.initialTier().id, '720p@30');
});

test('detect() works in node with defaults', () => {
  const cap = DeviceCapability.detect();
  assert.ok(cap.profile.hardwareConcurrency >= 1);
  assert.equal(typeof cap.profile.mobile, 'boolean');
});

test('estimateMaxResolution mirrors the initial tier', () => {
  const cap = DeviceCapability.fromInput({
    hardwareConcurrency: 8,
    deviceMemory: 8,
    mobile: false,
    screenWidth: 1920,
    screenHeight: 1080,
  });
  const res = cap.estimateMaxResolution();
  assert.deepEqual(res, { width: 1920, height: 1080, fps: 30 });
});

test('mobile penalty lowers the initial tier', () => {
  const phone = DeviceCapability.fromInput({
    hardwareConcurrency: 4,
    deviceMemory: 4,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  const desktop = DeviceCapability.fromInput({
    hardwareConcurrency: 4,
    deviceMemory: 4,
    mobile: false,
    screenWidth: 1920,
    screenHeight: 1080,
  });
  const phoneTier = phone.initialTier();
  const desktopTier = desktop.initialTier();
  assert.ok(tierIndexOf(phoneTier.id) >= tierIndexOf(desktopTier.id));
});

function tierIndexOf(id: string): number {
  return DEFAULT_QUALITY_TIERS.findIndex((t) => t.id === id);
}
