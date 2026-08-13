/**
 * Adaptive-quality wiring tests (docs/architecture.md D5):
 * RoomQualityController — stats sampling, policy application on fake senders
 * (setParameters/applyConstraints recording), event emission + warning codes,
 * hysteresis (no spam), device-profile initial tier, simulcast vs
 * single-encoding paths, unavailable-env guard, and the Room lifecycle
 * (join/leave stops the sampler, publish sets up simulcast, room events).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveQualityController,
  DeviceCapability,
  DEFAULT_QUALITY_TIERS,
} from '@vidcall/quality';
import type { RTCStatsSnapshot } from '@vidcall/quality';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import type { RoomQualityHost, StatsSampler, QualityPolicyEngine } from '../src/room-quality.ts';
import {
  RoomQualityController,
  RoomStatsSampler,
  qualityEnvironmentSupported,
  simulcastSupported,
  defaultSimulcastEncodings,
  qualityWarningCode,
} from '../src/room-quality.ts';
import type { LocalQualityChangedEvent, LocalQualityWarningEvent } from '../src/room-quality.ts';
import {
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  FakeSender,
  FakeSenderStats,
  asFake,
  resetFakeRTC,
} from '../../test-utils/src/index.ts';
import { sleep, waitFor } from '../../test-utils/src/fixtures.ts';

// ------------------------------------------------------------------ helpers

/** A device capable of the top tier — keeps tests deterministic. */
function strongDevice(): DeviceCapability {
  return DeviceCapability.fromInput({
    hardwareConcurrency: 16,
    deviceMemory: 32,
    mobile: false,
    screenWidth: 2560,
    screenHeight: 1440,
  });
}

function weakDevice(): DeviceCapability {
  return DeviceCapability.fromInput({
    hardwareConcurrency: 2,
    deviceMemory: 2,
    mobile: false,
    screenWidth: 1280,
    screenHeight: 800,
  });
}

function stubHost(senders: Array<FakeSender | RTCRtpSender>): RoomQualityHost {
  return {
    getSenders: () => senders.map((s) => s as unknown as RTCRtpSender),
    getPeerConnections: () => [],
  };
}

/** Sampler that replays a scripted snapshot sequence (degraded/healthy). */
class ScriptedSampler implements StatsSampler {
  readonly calls: RTCStatsSnapshot[] = [];
  private readonly snapshots: readonly RTCStatsSnapshot[];
  constructor(snapshots: readonly RTCStatsSnapshot[]) {
    this.snapshots = snapshots;
  }

  async sample(): Promise<RTCStatsSnapshot> {
    const index = Math.min(this.calls.length, this.snapshots.length - 1);
    const snapshot = { ...this.snapshots[index]! };
    this.calls.push(snapshot);
    return snapshot;
  }

  get tickCount(): number {
    return this.calls.length;
  }
}

/** Build a monotonic snapshot sequence (ts advances stepMs per entry). */
function sequence(partials: Array<Partial<RTCStatsSnapshot>>, stepMs = 1000): RTCStatsSnapshot[] {
  let ts = 1_700_000_000_000;
  return partials.map((partial) => {
    ts += stepMs;
    return { ts, ...partial };
  });
}

const HEALTHY = { availableOutgoingBitrateBps: 5_000_000 };
const DEGRADED = { availableOutgoingBitrateBps: 1_000_000 }; // 1000 kbps < 2070 (1080p headroom)
const HOLD_720P = { availableOutgoingBitrateBps: 1_200_000 }; // ok for 720p, no upgrade window
const SEVERE = { availableOutgoingBitrateBps: 100_000 }; // < 150 kbps -> audio-only

function makeController(options: {
  senders?: Array<FakeSender | RTCRtpSender>;
  sampler?: StatsSampler;
  policy?: QualityPolicyEngine;
  intervalMs?: number;
  simulcast?: false | ((track: MediaStreamTrack) => RTCRtpEncodingParameters[]);
  deviceCapability?: DeviceCapability;
  enabled?: boolean;
}): RoomQualityController {
  return new RoomQualityController({
    room: stubHost(options.senders ?? []),
    sampler: options.sampler,
    policy: options.policy,
    intervalMs: options.intervalMs ?? 1000,
    simulcast: options.simulcast ?? false,
    deviceCapability: options.deviceCapability ?? strongDevice(),
    enabled: options.enabled ?? true,
  });
}

// ------------------------------------------------------------- env detection

test('env guard: quality disabled by default in Node, enabled in browser-like envs', () => {
  assert.equal(qualityEnvironmentSupported(), false); // no window in Node
  assert.equal(
    qualityEnvironmentSupported({
      window: {},
      RTCPeerConnection: class {},
      navigator: { userAgent: 'Mozilla/5.0' },
    }),
    true,
  );
  assert.equal(
    qualityEnvironmentSupported({ window: {}, navigator: { userAgent: 'x' } }),
    false, // no RTCPeerConnection
  );
});

test('simulcast detection: Safari false, Chrome/Node true, no RTC false', () => {
  const chrome = {
    RTCPeerConnection: class {},
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120' },
  };
  const safari = {
    RTCPeerConnection: class {},
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    },
  };
  assert.equal(simulcastSupported(chrome), true);
  assert.equal(simulcastSupported(safari), false);
  assert.equal(simulcastSupported({ navigator: { userAgent: '' } }), false);
});

test('qualityWarningCode maps reasons/destinations to warning codes', () => {
  const base = { from: '1080p@30', tier: DEFAULT_QUALITY_TIERS[0]!, stats: { ts: 1 } };
  assert.equal(
    qualityWarningCode({ ...base, to: '720p@30', reason: 'network', direction: 'send' }),
    'network-degraded',
  );
  assert.equal(
    qualityWarningCode({ ...base, to: 'audio-only', reason: 'network', direction: 'send' }),
    'uplink-starved',
  );
  assert.equal(
    qualityWarningCode({ ...base, to: '720p@30', reason: 'cpu', direction: 'send' }),
    'cpu-high',
  );
  assert.equal(
    qualityWarningCode({ ...base, to: '720p@30', reason: 'device', direction: 'send' }),
    'device-capped',
  );
  assert.equal(
    qualityWarningCode({ ...base, to: '1080p@30', reason: 'recovery', direction: 'send' }),
    'recovered',
  );
  assert.equal(
    qualityWarningCode({ ...base, to: '720p@30', reason: 'manual', direction: 'send' }),
    'manual',
  );
});

// ------------------------------------------------------------- stats sampler

test('RoomStatsSampler aggregates candidate-pair/remote-inbound/outbound/inbound stats (worst value)', async () => {
  const pc1 = {
    connectionState: 'connected',
    getStats: async () =>
      new FakeSenderStats({
        rttMs: 100,
        availableOutgoingBitrateBps: 2_000_000,
        lossRate: 0.02,
        jitterMs: 30,
      }).toReport(),
  } as unknown as RTCPeerConnection;
  const pc2 = {
    connectionState: 'connected',
    getStats: async () =>
      new FakeSenderStats({
        rttMs: 250,
        availableOutgoingBitrateBps: 5_000_000,
        lossRate: 0.1,
        jitterMs: 60,
        qualityLimitationReason: 'cpu',
        totalEncodeTimeMs: 500,
        framesPerSecond: 24,
      }).toReport(),
  } as unknown as RTCPeerConnection;
  const sampler = new RoomStatsSampler({ getPeerConnections: () => [pc1, pc2], now: () => 1234 });
  const snapshot = await sampler.sample();
  assert.equal(snapshot.ts, 1234);
  assert.equal(snapshot.rttMs, 250); // max across peers
  assert.equal(snapshot.availableOutgoingBitrateBps, 5_000_000);
  assert.equal(snapshot.lossRate, 0.1);
  assert.equal(snapshot.jitterMs, 60);
  assert.equal(snapshot.qualityLimitationReason, 'cpu');
  assert.equal(snapshot.totalEncodeTimeMs, 500);
  assert.equal(snapshot.framesPerSecond, 24);
});

test('RoomStatsSampler skips closed/broken peers and falls back to packetsLost', async () => {
  const good = {
    connectionState: 'connected',
    getStats: async () => new FakeSenderStats({ packetsLost: 10, packetsReceived: 90 }).toReport(),
  } as unknown as RTCPeerConnection;
  const closed = {
    connectionState: 'closed',
    getStats: async () => {
      throw new Error('should not be called');
    },
  } as unknown as RTCPeerConnection;
  const broken = {
    connectionState: 'connected',
    getStats: async () => {
      throw new Error('boom');
    },
  } as unknown as RTCPeerConnection;
  const sampler = new RoomStatsSampler({
    getPeerConnections: () => [good, closed, broken],
    now: () => 7,
  });
  const snapshot = await sampler.sample();
  assert.equal(snapshot.lossRate, 0.1); // 10 / (90 + 10)
  assert.equal(snapshot.rttMs, undefined);
});

// ------------------------------------------- policy application (fake sender)

test('single-encoding path: downgrade applies constraints; setParameters untouched', async () => {
  const track = new FakeMediaStreamTrack('video');
  const sender = new FakeSender(track);
  const sampler = new ScriptedSampler(sequence([HEALTHY, DEGRADED, DEGRADED]));
  const changed: LocalQualityChangedEvent[] = [];
  const controller = makeController({ senders: [sender], sampler, simulcast: false });
  controller.on('quality:changed', (event) => changed.push(event));

  controller.start();
  await controller.attachTrack(track);
  await controller.pollNow(); // baseline
  await controller.pollNow(); // bad tick 1
  await controller.pollNow(); // bad tick 2 -> downgrade

  await waitFor(() => track.applyConstraintsCalls.length >= 2);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.from, '1080p@30');
  assert.equal(changed[0]!.to, '720p@30');
  assert.equal(changed[0]!.reason, 'network');
  assert.ok(changed[0]!.stats);
  assert.equal(sender.setParametersCalls.length, 0); // single-encoding path
  assert.deepEqual(track.applyConstraintsCalls[0], {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { max: 30 },
  });
  assert.deepEqual(track.applyConstraintsCalls[1], {
    width: { max: 1280 },
    height: { max: 720 },
    frameRate: { max: 30 },
  });
  controller.stop();
});

test('simulcast path: 3 encodings set up at attach; downgrade drops the high layer via setParameters', async () => {
  const track = new FakeMediaStreamTrack('video');
  const sender = new FakeSender(track);
  const sampler = new ScriptedSampler(sequence([HEALTHY, DEGRADED, DEGRADED]));
  const controller = makeController({
    senders: [sender],
    sampler,
    simulcast: defaultSimulcastEncodings,
  });

  controller.start();
  await controller.attachTrack(track);
  await sleep(0); // simulcast setup + initial apply resolve

  assert.equal(sender.encodings.length, 3);
  assert.equal(sender.encodings[0]!.rid, 'f');
  assert.equal(sender.encodings[0]!.maxBitrate, 2_500_000);
  assert.equal(sender.encodings[1]!.scaleResolutionDownBy, 2.0);
  assert.equal(sender.encodings[2]!.scaleResolutionDownBy, 4.0);

  await controller.pollNow(); // baseline
  await controller.pollNow(); // bad tick 1
  await controller.pollNow(); // bad tick 2 -> downgrade to 720p@30
  await waitFor(() => sender.setParametersCalls.length >= 3);

  const last = sender.setParametersCalls[sender.setParametersCalls.length - 1]!;
  assert.equal(last.encodings[0]!.active, false); // high layer dropped
  assert.equal(last.encodings[1]!.active, true);
  assert.equal(last.encodings[2]!.active, true);
  assert.equal(last.encodings[1]!.maxBitrate, 1_200_000); // tier cap (720p = 1200 kbps)
  assert.equal(track.applyConstraintsCalls.length, 0); // simulcast never touches constraints
  controller.stop();
});

test('hysteresis: controller never re-applies without a policy change (no spam)', async () => {
  const track = new FakeMediaStreamTrack('video');
  const sender = new FakeSender(track);
  // baseline, 2 bad ticks (->720p), then 6 hold ticks with 1200 kbps: no upgrade
  // window (10s), no further downgrade (1200 > 1035 = 720p headroom).
  const sampler = new ScriptedSampler(
    sequence([
      HEALTHY,
      DEGRADED,
      DEGRADED,
      HOLD_720P,
      HOLD_720P,
      HOLD_720P,
      HOLD_720P,
      HOLD_720P,
      HOLD_720P,
    ]),
  );
  const changed: string[] = [];
  const controller = makeController({ senders: [sender], sampler });
  controller.on('quality:changed', (event) => changed.push(`${event.from}->${event.to}`));

  controller.start();
  await controller.attachTrack(track);
  await waitFor(() => track.applyConstraintsCalls.length >= 1);
  const callsAfterAttach = track.applyConstraintsCalls.length;

  for (let i = 0; i < 8; i += 1) await controller.pollNow();
  await sleep(0);

  assert.deepEqual(changed, ['1080p@30->720p@30']); // exactly one change
  assert.equal(track.applyConstraintsCalls.length, callsAfterAttach + 1); // only the downgrade applied
  controller.stop();
});

test('audio-only pauses the track; recovery re-enables and re-applies constraints', async () => {
  const track = new FakeMediaStreamTrack('video');
  const sender = new FakeSender(track);
  const policy = new AdaptiveQualityController({
    initialTierId: '1080p@30',
    instantDowngradeTicks: 1,
    upgradeStableMs: 1000,
  });
  const sampler = new ScriptedSampler(sequence([HEALTHY, SEVERE, HEALTHY, HEALTHY], 2000));
  const warnings: LocalQualityWarningEvent[] = [];
  const changed: string[] = [];
  const controller = makeController({ senders: [sender], sampler, policy });
  controller.on('quality:warning', (event) => warnings.push(event));
  controller.on('quality:changed', (event) =>
    changed.push(`${event.from}->${event.to}:${event.reason}`),
  );

  controller.start();
  await controller.attachTrack(track);
  await controller.pollNow(); // baseline
  await controller.pollNow(); // severe -> audio-only
  await waitFor(() => track.enabled === false);
  assert.deepEqual(changed[0], '1080p@30->audio-only:network');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.code, 'uplink-starved');
  assert.equal(warnings[0]!.level, 'critical');

  await controller.pollNow(); // healthy
  await controller.pollNow(); // healthy -> upgrade window crossed (2000ms > 1000ms)
  await waitFor(() => track.enabled === true);
  assert.deepEqual(changed[1], 'audio-only->360p@15:recovery');
  assert.equal(warnings[1]!.code, 'recovered');
  assert.equal(warnings[1]!.level, 'info');
  const last = track.applyConstraintsCalls[track.applyConstraintsCalls.length - 1]!;
  assert.deepEqual(last, { width: { max: 640 }, height: { max: 360 }, frameRate: { max: 15 } });
  controller.stop();
});

test('device-profile initial tier caps the start (device-capped change + applied constraints)', async () => {
  const track = new FakeMediaStreamTrack('video');
  const sender = new FakeSender(track);
  const changed: LocalQualityChangedEvent[] = [];
  const controller = makeController({ senders: [sender], deviceCapability: weakDevice() });
  controller.on('quality:changed', (event) => changed.push(event));

  controller.start(); // captures device profile -> caps initial tier at 360p@15
  await sleep(0);
  assert.equal(controller.currentTierId, '360p@15');
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.from, '1080p@30');
  assert.equal(changed[0]!.to, '360p@15');
  assert.equal(changed[0]!.reason, 'device');

  await controller.attachTrack(track);
  await waitFor(() => track.applyConstraintsCalls.length >= 1);
  assert.deepEqual(track.applyConstraintsCalls[0], {
    width: { max: 640 },
    height: { max: 360 },
    frameRate: { max: 15 },
  });
  controller.stop();
});

test('a strong device does not downgrade the initial tier', async () => {
  const controller = makeController({ deviceCapability: strongDevice() });
  const changed: LocalQualityChangedEvent[] = [];
  controller.on('quality:changed', (event) => changed.push(event));
  controller.start();
  await sleep(0);
  assert.equal(controller.currentTierId, '1080p@30');
  assert.equal(changed.length, 0);
  controller.stop();
});

test('broken senders never crash attach or polling', async () => {
  const track = new FakeMediaStreamTrack('video');
  const sender = new FakeSender(track);
  const brokenTrack = new FakeMediaStreamTrack('video');
  (brokenTrack as unknown as { applyConstraints: () => Promise<void> }).applyConstraints =
    async () => {
      throw new Error('constraints unavailable');
    };
  const brokenSender = new FakeSender(brokenTrack);
  (brokenSender as unknown as { setParameters: () => Promise<void> }).setParameters = async () => {
    throw new Error('setParameters unavailable');
  };
  const controller = makeController({
    senders: [sender, brokenSender],
    simulcast: defaultSimulcastEncodings,
  });
  controller.start();
  await controller.attachTrack(track); // must not throw
  await controller.attachTrack(brokenTrack); // must not throw
  await controller.pollNow(); // must not throw
  await sleep(0);
  assert.ok(controller.managedTrackCount >= 1);
  controller.stop();
});

// ------------------------------------------------------- unavailable-env guard

test('unavailable-env guard: disabled controller is inert (no timers, no track control)', async () => {
  const track = new FakeMediaStreamTrack('video');
  const controller = makeController({ enabled: false, senders: [new FakeSender(track)] });
  assert.equal(controller.available, false);
  controller.start();
  assert.equal(controller.running, false);
  await controller.attachTrack(track);
  assert.equal(controller.managedTrackCount, 0);
  assert.equal(controller.currentTierId, undefined);
  await controller.pollNow(); // no-op
  assert.equal(track.applyConstraintsCalls.length, 0);
});

test('unavailable-env guard: default (no config) disables quality in Node', async () => {
  // No explicit `enabled`: env detection runs (false in Node).
  const controller = new RoomQualityController({ room: stubHost([]) });
  assert.equal(controller.available, false);
  const track = new FakeMediaStreamTrack('video');
  controller.start();
  await controller.attachTrack(track);
  assert.equal(controller.managedTrackCount, 0);
});

// ----------------------------------------------------------- lifecycle tests

test('lifecycle: start/stop control the sampler interval', async () => {
  const sampler = new ScriptedSampler(sequence(Array.from({ length: 50 }, () => HEALTHY)));
  const track = new FakeMediaStreamTrack('video');
  const controller = makeController({ senders: [new FakeSender(track)], sampler, intervalMs: 1 });
  controller.start();
  await controller.attachTrack(track);
  await waitFor(() => sampler.tickCount > 3);
  controller.stop();
  const afterStop = sampler.tickCount;
  await sleep(30);
  assert.equal(sampler.tickCount, afterStop); // interval cleared
});

test('pollNow drives exactly one cycle and skips when no video tracks are published', async () => {
  const sampler = new ScriptedSampler(sequence([HEALTHY]));
  const controller = makeController({ sampler });
  controller.start();
  await controller.pollNow(); // no tracks -> skipped
  assert.equal(sampler.tickCount, 0);
  const track = new FakeMediaStreamTrack('video');
  await controller.attachTrack(track);
  await controller.pollNow();
  assert.equal(sampler.tickCount, 1);
  controller.stop();
});

// ------------------------------------------------------- Room integration

beforeEach(() => resetFakeRTC());

/** Wired fake peer factories (same pattern as room.test.ts). */
function wiredPeerFactories() {
  const byKey = new Map<string, FakeRTCPeerConnection>();
  const wire = (k1: string, k2: string) => {
    const f1 = byKey.get(k1);
    const f2 = byKey.get(k2);
    if (f1 && f2) {
      f1.linkTo(f2);
      f2.linkTo(f1);
    }
  };
  return (selfId: string) =>
    (remoteId: string): RTCPeerConnection => {
      const key = `${selfId}->${remoteId}`;
      const existing = byKey.get(key);
      if (existing) return existing as unknown as RTCPeerConnection;
      const pc = new FakeRTCPeerConnection();
      byKey.set(key, pc);
      wire(key, `${remoteId}->${selfId}`);
      return pc as unknown as RTCPeerConnection;
    };
}

function makeQualityRoom(
  id: string,
  factory: (remoteId: string) => RTCPeerConnection,
  quality: NonNullable<ConstructorParameters<typeof Room>[0]['quality']>,
): Room {
  return new Room({
    roomId: 'room-1',
    selfId: id,
    displayName: `User ${id}`,
    transport: new InMemoryTransport(),
    peerFactory: factory,
    quality,
  });
}

test('Room integration: publish sets up simulcast, degraded sequence emits room events, leave stops the sampler', async () => {
  const factories = wiredPeerFactories();
  const sampler = new ScriptedSampler(
    sequence([HEALTHY, DEGRADED, DEGRADED, HOLD_720P, HOLD_720P, SEVERE, SEVERE, SEVERE]),
  );
  const a = makeQualityRoom('a', factories('a'), {
    enabled: true,
    intervalMs: 5,
    sampler,
    deviceCapability: strongDevice(),
    simulcast: defaultSimulcastEncodings,
  });
  const b = makeQualityRoom('b', factories('b'), {});

  // Env guard: no config -> inert in Node; explicit config -> active.
  assert.equal(a.quality.available, true);
  assert.equal(b.quality.available, false);

  const changed: LocalQualityChangedEvent[] = [];
  const warnings: LocalQualityWarningEvent[] = [];
  a.on('quality:changed', (event) => changed.push(event));
  a.on('quality:warning', (event) => warnings.push(event));

  await a.join();
  await b.join();
  await waitFor(() => !!a.getParticipant('b') && !!b.getParticipant('a'));

  const track = new FakeMediaStreamTrack('video');
  await a.publish(track);

  // attachTrack configured 3 simulcast encodings on the live fake sender.
  await waitFor(() => {
    const pc = asFake(a.getPeerConnection('b')!);
    if (!pc) return false;
    const senders = pc.getSenders();
    return senders.length > 0 && senders[0]!.getParameters().encodings.length === 3;
  });

  // Degraded sequence drives the real policy -> room-level events.
  await waitFor(() =>
    changed.some((e) => e.from === '1080p@30' && e.to === '720p@30' && e.reason === 'network'),
  );
  await waitFor(() => changed.some((e) => e.to === 'audio-only'));
  await waitFor(() => warnings.some((w) => w.code === 'uplink-starved'));
  assert.equal(warnings[0]!.level, 'critical');
  assert.equal(warnings[0]!.to, 'audio-only');
  assert.equal(sampler.tickCount > 0, true);

  // Leave stops the sampler.
  await a.leave();
  const afterLeave = sampler.tickCount;
  await sleep(40);
  assert.equal(sampler.tickCount, afterLeave);
  await b.leave();
});

test('Room integration: unpublished tracks are detached from quality control', async () => {
  const factories = wiredPeerFactories();
  const sampler = new ScriptedSampler(sequence([HEALTHY, HEALTHY, HEALTHY]));
  const a = makeQualityRoom('a', factories('a'), {
    enabled: true,
    intervalMs: 5,
    sampler,
    deviceCapability: strongDevice(),
  });
  const b = makeQualityRoom('b', factories('b'), {});
  await a.join();
  await b.join();
  await waitFor(() => !!a.getParticipant('b') && !!b.getParticipant('a'));

  const track = new FakeMediaStreamTrack('video');
  const pub = await a.publish(track);
  await waitFor(() => {
    const pc = asFake(a.getPeerConnection('b')!);
    return !!pc && pc.getSenders().length > 0;
  });
  assert.equal(a.quality.managedTrackCount, 1);
  await a.unpublish(pub);
  assert.equal(a.quality.managedTrackCount, 0);
  await a.leave();
  await b.leave();
});
