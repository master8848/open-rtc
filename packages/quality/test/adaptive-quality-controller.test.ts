import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveQualityController } from '../src/adaptive-quality-controller.ts';
import { statsSnapshot } from '../src/stats.ts';
import type { RTCStatsSnapshot } from '../src/stats.ts';

/** A snapshot factory that advances ts by `stepMs` per call. */
function ticker(stepMs = 1000): (partial?: Partial<RTCStatsSnapshot>) => RTCStatsSnapshot {
  let ts = 1_700_000_000_000;
  return (partial = {}) => {
    ts += stepMs;
    return statsSnapshot({ ts, ...partial });
  };
}

test('first tick is a baseline (no change)', () => {
  const c = new AdaptiveQualityController();
  const t = ticker();
  const d = c.tick(t({ availableOutgoingBitrateBps: 5_000_000 }));
  assert.equal(d.changed, false);
  assert.equal(c.currentTierId, '1080p@30');
});

test('network: low bitrate downgrades after the instant-downgrade window', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30', instantDowngradeTicks: 2 });
  const t = ticker();
  // 1080p@30 requires 1800 kbps; headroom 1.15 -> need >= 2070 kbps.
  const bad = () => t({ availableOutgoingBitrateBps: 1_000_000 }); // 1000 kbps
  c.tick(t({ availableOutgoingBitrateBps: 5_000_000 })); // baseline
  assert.equal(c.tick(bad()).changed, false); // 1 bad tick
  const d = c.tick(bad());
  assert.equal(d.changed, true);
  assert.equal(d.action, 'downgrade');
  assert.equal(d.reason, 'network');
  assert.equal(c.currentTierId, '720p@30');
});

test('network: high RTT downgrades', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30', instantDowngradeTicks: 1 });
  const t = ticker();
  c.tick(t({ rttMs: 20 }));
  const d = c.tick(t({ rttMs: 500 }));
  assert.equal(d.reason, 'network');
  assert.equal(c.currentTierId, '720p@30');
});

test('network: loss rate above 5% downgrades', () => {
  const c = new AdaptiveQualityController({ initialTierId: '720p@30', instantDowngradeTicks: 1 });
  const t = ticker();
  c.tick(t({ lossRate: 0 }));
  const d = c.tick(t({ lossRate: 0.08 }));
  assert.equal(d.reason, 'network');
  assert.equal(c.currentTierId, '480p@30');
});

test('severe congestion skips straight to audio-only', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30', instantDowngradeTicks: 3 });
  const t = ticker();
  c.tick(t({ availableOutgoingBitrateBps: 5_000_000 })); // baseline
  const d = c.tick(t({ availableOutgoingBitrateBps: 100_000 })); // 100 kbps < 150
  assert.equal(d.changed, true);
  assert.equal(c.currentTierId, 'audio-only');
});

test('cpu: qualityLimitationReason === cpu downgrades', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30', cpuTicksToDowngrade: 2 });
  const t = ticker();
  c.tick(t({ availableOutgoingBitrateBps: 5_000_000 })); // baseline
  assert.equal(c.tick(t({ qualityLimitationReason: 'cpu' })).changed, false); // 1 cpu tick
  const d = c.tick(t({ qualityLimitationReason: 'cpu' })); // 2nd cpu tick
  assert.equal(d.reason, 'cpu');
  assert.equal(c.currentTierId, '720p@30');
});

test('cpu: encode-duty slope above 0.75 downgrades', () => {
  const c = new AdaptiveQualityController({ initialTierId: '720p@30', cpuTicksToDowngrade: 1 });
  const t = ticker(1000);
  // Baseline encode time, then a 900ms encode jump in a 1000ms window (0.9 duty).
  c.tick(t({ totalEncodeTimeMs: 0 }));
  const d = c.tick(t({ totalEncodeTimeMs: 900 }));
  assert.equal(d.reason, 'cpu');
  assert.equal(c.currentTierId, '480p@30');
});

test('cpu: cumulative durations slope above 50% counts as CPU pressure', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30', cpuTicksToDowngrade: 1 });
  const t = ticker(1000);
  c.tick(t({ qualityLimitationDurationsMs: { cpu: 0 } }));
  const d = c.tick(t({ qualityLimitationDurationsMs: { cpu: 800 } })); // 800/1000 = 0.8
  assert.equal(d.reason, 'cpu');
});

test('hysteresis: no upgrade before the stability window', () => {
  const c = new AdaptiveQualityController({ initialTierId: '720p@30', upgradeStableMs: 10_000 });
  const t = ticker(1000);
  // Good conditions for 5s: no upgrade yet.
  for (let i = 0; i < 5; i++) c.tick(t({ availableOutgoingBitrateBps: 5_000_000 }));
  assert.equal(c.currentTierId, '720p@30');
  // After 10s of headroom: upgrade exactly one tier.
  for (let i = 0; i < 6; i++) c.tick(t({ availableOutgoingBitrateBps: 5_000_000 }));
  assert.equal(c.currentTierId, '1080p@30');
});

test('hysteresis: upgrade requires 25% headroom', () => {
  const c = new AdaptiveQualityController({ initialTierId: '720p@30', upgradeStableMs: 1000 });
  const t = ticker(1000);
  // 720p requires 900 kbps; 1.25 headroom -> need > 1125 kbps. 1000 kbps is
  // enough to sustain but not enough to upgrade.
  for (let i = 0; i < 5; i++) c.tick(t({ availableOutgoingBitrateBps: 1_000_000 }));
  assert.equal(c.currentTierId, '720p@30');
});

test('upgrade happens one tier at a time', () => {
  const c = new AdaptiveQualityController({ initialTierId: '360p@15', upgradeStableMs: 5000 });
  const t = ticker(1000);
  c.tick(t({ availableOutgoingBitrateBps: 10_000_000 })); // baseline (starts the window)
  // 5s window: good ticks t2..t5 keep 360p, t6 crosses 5000ms and steps up.
  for (let i = 0; i < 4; i++) c.tick(t({ availableOutgoingBitrateBps: 10_000_000 }));
  assert.equal(c.currentTierId, '360p@15');
  c.tick(t({ availableOutgoingBitrateBps: 10_000_000 }));
  assert.equal(c.currentTierId, '480p@30'); // exactly one step up
});

test('downgrade resets the upgrade window (anti-oscillation)', () => {
  const c = new AdaptiveQualityController({
    initialTierId: '1080p@30',
    instantDowngradeTicks: 1,
    upgradeStableMs: 10_000,
  });
  const t = ticker(1000);
  c.tick(t({ availableOutgoingBitrateBps: 5_000_000 })); // baseline
  c.tick(t({ availableOutgoingBitrateBps: 500_000 })); // downgrade
  assert.equal(c.currentTierId, '720p@30');
  // Immediate good conditions: must stay put for the full window.
  for (let i = 0; i < 5; i++) c.tick(t({ availableOutgoingBitrateBps: 5_000_000 }));
  assert.equal(c.currentTierId, '720p@30'); // no bounce-back
});

test('deviceScore clamps the tier', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30' });
  const t = ticker();
  c.tick(t({ availableOutgoingBitrateBps: 5_000_000 })); // baseline
  const d = c.tick(t({ deviceScore: 0.4 })); // -> 480p@30
  assert.equal(d.reason, 'device');
  assert.equal(c.currentTierId, '480p@30');
});

test('maxTierId prevents upgrades above the cap', () => {
  const c = new AdaptiveQualityController({
    initialTierId: '360p@15',
    maxTierId: '720p@30',
    upgradeStableMs: 1000,
  });
  const t = ticker(1000);
  c.tick(t({ availableOutgoingBitrateBps: 10_000_000 })); // baseline
  // t3: first upgrade -> 480p@30; t5: second -> 720p@30 (capped).
  for (let i = 0; i < 2; i++) c.tick(t({ availableOutgoingBitrateBps: 10_000_000 }));
  assert.equal(c.currentTierId, '480p@30');
  for (let i = 0; i < 10; i++) c.tick(t({ availableOutgoingBitrateBps: 10_000_000 }));
  assert.equal(c.currentTierId, '720p@30'); // reached the cap
  for (let i = 0; i < 10; i++) c.tick(t({ availableOutgoingBitrateBps: 10_000_000 }));
  assert.equal(c.currentTierId, '720p@30'); // stays capped
});

test('manual setTier emits with reason manual and direction fields', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30' });
  const changes: Array<{ from: string; to: string; reason: string; direction: string }> = [];
  c.on('quality:changed', (e) =>
    changes.push({ from: e.from, to: e.to, reason: e.reason, direction: e.direction }),
  );
  const d = c.setTier('480p@30', 'manual');
  assert.equal(d.action, 'set');
  assert.equal(d.reason, 'manual');
  assert.equal(c.currentTierId, '480p@30');
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.from, '1080p@30');
  assert.equal(changes[0]!.to, '480p@30');
  assert.equal(changes[0]!.reason, 'manual');
  assert.equal(changes[0]!.direction, 'send');
});

test('events: quality:changed and quality:warning carry from/to/reason/direction', () => {
  const c = new AdaptiveQualityController({
    initialTierId: '1080p@30',
    instantDowngradeTicks: 1,
    direction: 'receive',
  });
  const changed: string[] = [];
  const warnings: Array<{
    from: string;
    to: string;
    reason: string;
    direction: string;
    level: string;
  }> = [];
  c.on('quality:changed', (e) => changed.push(`${e.from}->${e.to}:${e.reason}`));
  c.on('quality:warning', (e) =>
    warnings.push({
      from: e.from,
      to: e.to,
      reason: e.reason,
      direction: e.direction,
      level: e.level,
    }),
  );

  const t = ticker();
  c.tick(t({ rttMs: 20 })); // baseline
  c.tick(t({ rttMs: 900 })); // severe -> audio-only
  assert.deepEqual(changed, ['1080p@30->audio-only:network']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.from, '1080p@30');
  assert.equal(warnings[0]!.to, 'audio-only');
  assert.equal(warnings[0]!.reason, 'network');
  assert.equal(warnings[0]!.direction, 'receive');
  assert.equal(warnings[0]!.level, 'critical');
});

test('recovery from audio-only emits an info warning', () => {
  const c = new AdaptiveQualityController({
    initialTierId: '1080p@30',
    instantDowngradeTicks: 1,
    upgradeStableMs: 1000,
  });
  const t = ticker(1000);
  const warnings: string[] = [];
  c.on('quality:warning', (e) => warnings.push(`${e.level}:${e.message}`));
  c.tick(t({ rttMs: 20 })); // baseline
  c.tick(t({ rttMs: 900 })); // -> audio-only (critical)
  // After 2 good ticks (1000ms each, window 1000ms) we step up exactly one tier.
  c.tick(t({ rttMs: 20, availableOutgoingBitrateBps: 10_000_000 }));
  c.tick(t({ rttMs: 20, availableOutgoingBitrateBps: 10_000_000 }));
  assert.equal(c.currentTierId, '360p@15');
  assert.ok(warnings.some((w) => w.startsWith('info:Video quality improved')));
});

test('downgrade into 360p@15 emits a warn-level warning', () => {
  const c = new AdaptiveQualityController({ initialTierId: '480p@30', instantDowngradeTicks: 1 });
  const t = ticker();
  const warnings: string[] = [];
  c.on('quality:warning', (e) => warnings.push(e.level));
  c.tick(t({ lossRate: 0 })); // baseline
  c.tick(t({ lossRate: 0.3 }));
  assert.equal(c.currentTierId, '360p@15');
  assert.ok(warnings.includes('warn'));
});

test('reset restores the initial tier and windows', () => {
  const c = new AdaptiveQualityController({ initialTierId: '1080p@30', instantDowngradeTicks: 1 });
  const t = ticker();
  c.tick(t({ rttMs: 20 })); // baseline
  c.tick(t({ rttMs: 900 }));
  assert.equal(c.currentTierId, 'audio-only');
  c.reset();
  assert.equal(c.currentTierId, '1080p@30');
  assert.equal(c.tick(t({ availableOutgoingBitrateBps: 5_000_000 })).changed, false); // fresh baseline
});

test('unknown manual tier throws', () => {
  const c = new AdaptiveQualityController();
  assert.throws(() => c.setTier('8k@60'), /unknown tier/);
});

test('no WebRTC imports: controller works on plain snapshots', () => {
  // (structural check — quality package has no runtime deps beyond protocol)
  const c = new AdaptiveQualityController();
  const t = ticker();
  c.tick(t({ rttMs: 10, availableOutgoingBitrateBps: 4_000_000 }));
  assert.ok(c.currentTier);
});
