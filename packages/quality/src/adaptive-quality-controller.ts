/**
 * AdaptiveQualityController — pure policy engine (webrtc-js.md §5.5, D5).
 *
 * Consumes `RTCStatsSnapshot`s (no WebRTC imports) and walks the tier ladder:
 *  - **Instant downgrade** on network congestion (RTT/loss/bitrate) or CPU
 *    pressure (`qualityLimitationReason === 'cpu'` or encode-duty slope);
 *    severe congestion (RTT > 800ms or estimate < 150 kbps) skips straight to
 *    audio-only.
 *  - **Hysteresis**: upgrades happen at most one tier at a time, only after
 *    the tier has been stable for >= 10s with >= 25% bitrate headroom.
 *  - **Device cap**: `deviceScore` in the snapshot clamps the tier.
 *
 * Emits:
 *  - `quality:changed` — `{ from, to, reason, direction, tier, stats }`
 *  - `quality:warning`  — same fields + `{ level, message }` for app toasts.
 */
import type { QualityWarningDirection, QualityWarningReason } from '@mbsks/protocol';
import { TypedEmitter } from './events.ts';
import type { RTCStatsSnapshot } from './stats.ts';
import {
  AUDIO_ONLY_TIER_ID,
  DEFAULT_QUALITY_TIERS,
  findTier,
  nextHigherTier,
  nextLowerTier,
  tierIndex,
} from './tiers.ts';
import type { QualityTier } from './tiers.ts';
import { initialTierForScore } from './device-capability.ts';

export interface AdaptiveQualityConfig {
  tiers?: readonly QualityTier[];
  /** Initial tier id (default: highest tier in the ladder). */
  initialTierId?: string;
  /** Never upgrade above this tier (e.g. from DeviceCapability.initialTier()). */
  maxTierId?: string;
  direction?: QualityWarningDirection;

  // network downgrade thresholds
  /** Downgrade when RTT exceeds this (ms). */
  downgradeRttMs?: number; // 400
  /** Downgrade when loss rate exceeds this (0..1). */
  downgradeLossRate?: number; // 0.05
  /** Downgrade when estimate < requiredBitrate × headroom. */
  downgradeBitrateHeadroom?: number; // 1.15
  /** Consecutive bad ticks that trigger a network downgrade. */
  instantDowngradeTicks?: number; // 2
  /** RTT above this skips straight to audio-only. */
  severeRttMs?: number; // 800
  /** Estimate below this (kbps) skips straight to audio-only. */
  severeBitrateKbps?: number; // 150

  // cpu downgrade thresholds
  /** Consecutive CPU-limited ticks that trigger a downgrade. */
  cpuTicksToDowngrade?: number; // 2
  /** Encode duty cycle above this counts as CPU pressure. */
  cpuEncodeDutyThreshold?: number; // 0.75
  /** Fraction of the poll window spent CPU-limited (durations delta) to count. */
  cpuDurationFraction?: number; // 0.5

  // upgrade hysteresis
  /** Stable time before an upgrade is allowed (ms). */
  upgradeStableMs?: number; // 10_000
  /** Estimate must exceed requiredBitrate × headroom to upgrade. */
  upgradeBitrateHeadroom?: number; // 1.25
  /** Max tier steps per upgrade decision. */
  maxUpgradeSteps?: number; // 1
}

export type QualityAction = 'none' | 'downgrade' | 'upgrade' | 'set';

export interface QualityDecision {
  action: QualityAction;
  from: string;
  to: string;
  changed: boolean;
  reason?: QualityWarningReason;
  tier: QualityTier;
}

export interface QualityChangeEvent {
  from: string;
  to: string;
  reason: QualityWarningReason;
  direction: QualityWarningDirection;
  tier: QualityTier;
  stats: RTCStatsSnapshot;
}

export interface QualityWarningEvent extends QualityChangeEvent {
  level: 'info' | 'warn' | 'critical';
  message: string;
}

export type QualityEventMap = {
  'quality:changed': [QualityChangeEvent];
  'quality:warning': [QualityWarningEvent];
};

const DEFAULTS = {
  downgradeRttMs: 400,
  downgradeLossRate: 0.05,
  downgradeBitrateHeadroom: 1.15,
  instantDowngradeTicks: 2,
  severeRttMs: 800,
  severeBitrateKbps: 150,
  cpuTicksToDowngrade: 2,
  cpuEncodeDutyThreshold: 0.75,
  cpuDurationFraction: 0.5,
  upgradeStableMs: 10_000,
  upgradeBitrateHeadroom: 1.25,
  maxUpgradeSteps: 1,
} as const;

export class AdaptiveQualityController extends TypedEmitter<QualityEventMap> {
  readonly tiers: readonly QualityTier[];
  readonly direction: QualityWarningDirection;
  private readonly config: Required<
    Pick<
      AdaptiveQualityConfig,
      | 'downgradeRttMs'
      | 'downgradeLossRate'
      | 'downgradeBitrateHeadroom'
      | 'instantDowngradeTicks'
      | 'severeRttMs'
      | 'severeBitrateKbps'
      | 'cpuTicksToDowngrade'
      | 'cpuEncodeDutyThreshold'
      | 'cpuDurationFraction'
      | 'upgradeStableMs'
      | 'upgradeBitrateHeadroom'
      | 'maxUpgradeSteps'
    >
  >;
  private readonly initialTierId?: string;
  private readonly maxTierId?: string;

  private current: QualityTier;
  private lastTs: number | null = null;
  private lastEncodeTime: number | null = null;
  private lastCpuDuration: number | null = null;
  private stableSince: number | null = null;
  private networkBadTicks = 0;
  private cpuTicks = 0;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: AdaptiveQualityConfig = {}) {
    super();
    this.tiers = options.tiers ?? DEFAULT_QUALITY_TIERS;
    this.direction = options.direction ?? 'send';
    this.config = {
      downgradeRttMs: options.downgradeRttMs ?? DEFAULTS.downgradeRttMs,
      downgradeLossRate: options.downgradeLossRate ?? DEFAULTS.downgradeLossRate,
      downgradeBitrateHeadroom:
        options.downgradeBitrateHeadroom ?? DEFAULTS.downgradeBitrateHeadroom,
      instantDowngradeTicks: options.instantDowngradeTicks ?? DEFAULTS.instantDowngradeTicks,
      severeRttMs: options.severeRttMs ?? DEFAULTS.severeRttMs,
      severeBitrateKbps: options.severeBitrateKbps ?? DEFAULTS.severeBitrateKbps,
      cpuTicksToDowngrade: options.cpuTicksToDowngrade ?? DEFAULTS.cpuTicksToDowngrade,
      cpuEncodeDutyThreshold: options.cpuEncodeDutyThreshold ?? DEFAULTS.cpuEncodeDutyThreshold,
      cpuDurationFraction: options.cpuDurationFraction ?? DEFAULTS.cpuDurationFraction,
      upgradeStableMs: options.upgradeStableMs ?? DEFAULTS.upgradeStableMs,
      upgradeBitrateHeadroom: options.upgradeBitrateHeadroom ?? DEFAULTS.upgradeBitrateHeadroom,
      maxUpgradeSteps: options.maxUpgradeSteps ?? DEFAULTS.maxUpgradeSteps,
    };
    this.initialTierId = options.initialTierId;
    this.maxTierId = options.maxTierId;
    this.current = this.resolveInitialTier();
  }

  // -------------------------------------------------------------- accessors

  get currentTier(): QualityTier {
    return this.current;
  }

  get currentTierId(): string {
    return this.current.id;
  }

  /** Index of the current tier in the ladder (0 = highest). */
  get currentIndex(): number {
    return tierIndex(this.tiers, this.current.id);
  }

  // --------------------------------------------------------------- decisions

  /**
   * Evaluate one stats snapshot. Pure: all state is internal; `snapshot.ts`
   * drives the time base, so tests can fast-forward by faking timestamps.
   */
  tick(snapshot: RTCStatsSnapshot): QualityDecision {
    const ts = snapshot.ts;
    if (this.lastTs === null) {
      // First tick: baseline only.
      this.lastTs = ts;
      this.stableSince = ts;
      this.captureCpuBaselines(snapshot);
      return {
        action: 'none',
        from: this.current.id,
        to: this.current.id,
        changed: false,
        tier: this.current,
      };
    }
    const dt = Math.max(ts - this.lastTs, 1);
    this.lastTs = ts;

    const decision = this.evaluate(snapshot, dt);
    if (decision.changed) {
      const previous = this.current;
      this.current = decision.tier;
      this.stableSince = null;
      this.networkBadTicks = 0;
      this.cpuTicks = 0;
      const event: QualityChangeEvent = {
        from: previous.id,
        to: decision.tier.id,
        reason: decision.reason ?? 'network',
        direction: this.direction,
        tier: decision.tier,
        stats: snapshot,
      };
      this.emit('quality:changed', event);
      const warning = this.buildWarning(event);
      if (warning) this.emit('quality:warning', warning);
    } else {
      // No change this tick: keep the upgrade window open.
      if (this.stableSince === null) this.stableSince = ts;
    }
    this.captureCpuBaselines(snapshot);
    return decision;
  }

  /** Manual override (reason 'manual', or 'device' for capability changes). */
  setTier(tierId: string, reason: QualityWarningReason = 'manual'): QualityDecision {
    const tier = findTier(this.tiers, tierId);
    if (!tier) throw new Error(`AdaptiveQualityController: unknown tier '${tierId}'`);
    if (tier.id === this.current.id) {
      return {
        action: 'none',
        from: this.current.id,
        to: this.current.id,
        changed: false,
        reason,
        tier: this.current,
      };
    }
    const previous = this.current;
    this.current = tier;
    this.stableSince = null;
    const event: QualityChangeEvent = {
      from: previous.id,
      to: tier.id,
      reason,
      direction: this.direction,
      tier,
      stats: { ts: Date.now() },
    };
    this.emit('quality:changed', event);
    const warning = this.buildWarning(event);
    if (warning) this.emit('quality:warning', warning);
    return { action: 'set', from: previous.id, to: tier.id, changed: true, reason, tier };
  }

  /** Reset all state (e.g. when a track is replaced or a call restarts). */
  reset(): void {
    this.current = this.resolveInitialTier();
    this.lastTs = null;
    this.lastEncodeTime = null;
    this.lastCpuDuration = null;
    this.stableSince = null;
    this.networkBadTicks = 0;
    this.cpuTicks = 0;
  }

  // ------------------------------------------------------------- live polling

  /** Poll `getSnapshot` every `intervalMs` and feed `tick()`. */
  start(getSnapshot: () => RTCStatsSnapshot, intervalMs = 1000): this {
    if (this.interval) return this;
    this.interval = setInterval(() => {
      try {
        this.tick(getSnapshot());
      } catch (err) {
        // Polling must never crash the app.
        this.emit('quality:warning', {
          from: this.current.id,
          to: this.current.id,
          reason: 'device',
          direction: this.direction,
          tier: this.current,
          stats: { ts: Date.now() },
          level: 'info',
          message: `Quality monitor error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, intervalMs);
    return this;
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // -------------------------------------------------------------- internals

  private resolveInitialTier(): QualityTier {
    const id = this.initialTierId ?? this.tiers[0]?.id;
    const tier = id ? findTier(this.tiers, id) : undefined;
    if (tier) return tier;
    throw new Error('AdaptiveQualityController: tier ladder is empty');
  }

  private captureCpuBaselines(snapshot: RTCStatsSnapshot): void {
    if (snapshot.totalEncodeTimeMs !== undefined) this.lastEncodeTime = snapshot.totalEncodeTimeMs;
    if (snapshot.qualityLimitationDurationsMs?.cpu !== undefined) {
      this.lastCpuDuration = snapshot.qualityLimitationDurationsMs.cpu;
    }
  }

  private evaluate(snapshot: RTCStatsSnapshot, dt: number): QualityDecision {
    const tier = this.current;
    const idx = this.currentIndex;
    const bitrateKbps =
      snapshot.availableOutgoingBitrateBps !== undefined
        ? snapshot.availableOutgoingBitrateBps / 1000
        : undefined;

    const noop = (reason?: QualityWarningReason): QualityDecision => ({
      action: 'none',
      from: tier.id,
      to: tier.id,
      changed: false,
      reason,
      tier,
    });

    // 1. Severe congestion → skip straight to audio-only (research §5.5).
    const severe =
      (snapshot.rttMs !== undefined && snapshot.rttMs > this.config.severeRttMs) ||
      (bitrateKbps !== undefined && bitrateKbps < this.config.severeBitrateKbps);
    if (severe) {
      const audioOnly =
        findTier(this.tiers, AUDIO_ONLY_TIER_ID) ?? this.tiers[this.tiers.length - 1]!;
      if (idx < tierIndex(this.tiers, audioOnly.id)) {
        return {
          action: 'downgrade',
          from: tier.id,
          to: audioOnly.id,
          changed: true,
          reason: 'network',
          tier: audioOnly,
        };
      }
      return noop();
    }

    // 2. Network congestion (downgrade after N consecutive bad ticks).
    const networkBad =
      (bitrateKbps !== undefined &&
        bitrateKbps < tier.requiredBitrateKbps * this.config.downgradeBitrateHeadroom) ||
      (snapshot.rttMs !== undefined && snapshot.rttMs > this.config.downgradeRttMs) ||
      (snapshot.lossRate !== undefined && snapshot.lossRate > this.config.downgradeLossRate);
    if (networkBad) {
      this.networkBadTicks += 1;
      this.cpuTicks = 0;
      if (this.networkBadTicks >= this.config.instantDowngradeTicks) {
        const lower = nextLowerTier(this.tiers, tier.id);
        if (lower) {
          this.networkBadTicks = 0;
          return {
            action: 'downgrade',
            from: tier.id,
            to: lower.id,
            changed: true,
            reason: 'network',
            tier: lower,
          };
        }
      }
      return noop('network');
    }
    this.networkBadTicks = 0;

    // 3. CPU pressure → downgrade (don't wait for the network estimate).
    if (this.cpuPressure(snapshot, dt)) {
      this.cpuTicks += 1;
      if (this.cpuTicks >= this.config.cpuTicksToDowngrade) {
        const lower = nextLowerTier(this.tiers, tier.id);
        if (lower) {
          this.cpuTicks = 0;
          return {
            action: 'downgrade',
            from: tier.id,
            to: lower.id,
            changed: true,
            reason: 'cpu',
            tier: lower,
          };
        }
      }
      return noop('cpu');
    }
    this.cpuTicks = 0;

    // 4. Device capability clamp (a snapshot-level score below the tier).
    const deviceCap =
      snapshot.deviceScore !== undefined
        ? initialTierForScore(snapshot.deviceScore, this.tiers)
        : undefined;
    const deviceIdx = deviceCap ? tierIndex(this.tiers, deviceCap.id) : -1;
    if (deviceIdx >= 0 && idx < deviceIdx) {
      return {
        action: 'downgrade',
        from: tier.id,
        to: deviceCap!.id,
        changed: true,
        reason: 'device',
        tier: deviceCap!,
      };
    }

    // 5. Upgrade — only after a stability window with bitrate headroom.
    if (this.stableSince === null) this.stableSince = snapshot.ts;
    const stableMs = snapshot.ts - this.stableSince;
    const headroomOk =
      bitrateKbps === undefined ||
      bitrateKbps > tier.requiredBitrateKbps * this.config.upgradeBitrateHeadroom;
    const maxIdx = this.maxTierId ? Math.max(tierIndex(this.tiers, this.maxTierId), 0) : 0;
    const minAllowedIdx = Math.max(maxIdx, deviceIdx);
    if (stableMs >= this.config.upgradeStableMs && headroomOk && idx > minAllowedIdx) {
      let higher = nextHigherTier(this.tiers, tier.id);
      for (let step = 1; higher && step < this.config.maxUpgradeSteps; step += 1) {
        const next = nextHigherTier(this.tiers, higher.id);
        if (!next) break;
        higher = next;
      }
      if (higher && tierIndex(this.tiers, higher.id) >= minAllowedIdx) {
        this.stableSince = snapshot.ts; // restart the window after an upgrade
        return {
          action: 'upgrade',
          from: tier.id,
          to: higher.id,
          changed: true,
          reason: 'recovery',
          tier: higher,
        };
      }
    }
    return noop();
  }

  private cpuPressure(snapshot: RTCStatsSnapshot, dt: number): boolean {
    // a) The encoder itself reports CPU limitation.
    if (snapshot.qualityLimitationReason === 'cpu') return true;
    // b) Cumulative durations: CPU-limited fraction of this poll window.
    if (snapshot.qualityLimitationDurationsMs && this.lastCpuDuration !== null) {
      const cpuDur = snapshot.qualityLimitationDurationsMs.cpu ?? 0;
      const delta = cpuDur - this.lastCpuDuration;
      if (delta > 0 && delta / dt > this.config.cpuDurationFraction) return true;
    }
    // c) Encode duty cycle: ΔtotalEncodeTime / wall time.
    if (snapshot.totalEncodeTimeMs !== undefined && this.lastEncodeTime !== null) {
      const duty = Math.max(0, snapshot.totalEncodeTimeMs - this.lastEncodeTime) / dt;
      if (duty > this.config.cpuEncodeDutyThreshold) return true;
    }
    return false;
  }

  private buildWarning(event: QualityChangeEvent): QualityWarningEvent | null {
    const { from, to, reason } = event;
    const downgrade = tierIndex(this.tiers, to) > tierIndex(this.tiers, from);
    const toAudioOnly = to === AUDIO_ONLY_TIER_ID;

    if (toAudioOnly && downgrade) {
      const message =
        reason === 'cpu'
          ? 'Video paused — this device is struggling to encode'
          : 'Video paused — network too slow for video';
      return { ...event, level: 'critical', message };
    }
    if (downgrade && to === '360p@15') {
      const message =
        reason === 'cpu'
          ? 'Video quality reduced — this device is struggling to encode'
          : reason === 'device'
            ? 'Video quality reduced — device capability limit'
            : 'Video quality reduced — slow network';
      return { ...event, level: 'warn', message };
    }
    if (!downgrade && from === AUDIO_ONLY_TIER_ID) {
      return { ...event, level: 'info', message: 'Video quality improved' };
    }
    if (reason === 'manual') {
      return { ...event, level: 'info', message: `Quality set manually to ${to}` };
    }
    return null;
  }
}
