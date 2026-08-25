/**
 * DeviceCapability — initial quality caps from device profile
 * (webrtc-js.md §5.4, docs/architecture.md D5a).
 *
 * Inputs: `hardwareConcurrency`, `deviceMemory` (Chrome), mobile heuristic,
 * screen size. Outputs: a `DeviceProfile` (wire format), a 0..1 device score,
 * and an initial quality tier.
 *
 * Pure: no WebRTC imports. `detect()` reads `navigator` defensively.
 */
import type { DeviceProfile as WireDeviceProfile, Platform } from '@mbsks/protocol';
import { DEFAULT_QUALITY_TIERS, findTier, tierIndex } from './tiers.ts';
import type { QualityTier } from './tiers.ts';

export interface DeviceProfileInput {
  hardwareConcurrency?: number;
  /** GB; Chrome-only (`navigator.deviceMemory`). */
  deviceMemory?: number;
  mobile?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  platform?: Platform;
}

/** Minimal navigator shape we read (feature-detect friendly). */
export interface NavigatorLike {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
  userAgent?: string;
  screen?: { width?: number; height?: number };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Rough heuristics for a 0..1 "processing headroom" score. */
export function computeDeviceScore(input: DeviceProfileInput): number {
  const hc = input.hardwareConcurrency ?? 4;
  const mem = input.deviceMemory ?? 4;
  const coresScore = clamp01((hc - 1) / 7); // 1 core → 0, 8+ → 1
  const memScore = clamp01(mem / 8); // 8+ GB → 1
  const minDim = Math.min(input.screenWidth ?? 1920, input.screenHeight ?? 1080);
  const screenScore = clamp01(minDim / 1080);
  let score = 0.45 * coresScore + 0.35 * memScore + 0.2 * screenScore;
  if (input.mobile) score *= 0.7;
  return clamp01(score);
}

/** Initial tier from a device score (webrtc-js.md §5.4). */
export function initialTierForScore(
  score: number,
  tiers: readonly QualityTier[] = DEFAULT_QUALITY_TIERS,
): QualityTier {
  if (score >= 0.75) return tiers[0] ?? DEFAULT_QUALITY_TIERS[0]!;
  if (score >= 0.55) return findTier(tiers, '720p@30') ?? tiers[0]!;
  if (score >= 0.35) return findTier(tiers, '480p@30') ?? tiers[0]!;
  if (score >= 0.2) return findTier(tiers, '360p@15') ?? tiers[0]!;
  return findTier(tiers, 'audio-only') ?? tiers[tiers.length - 1]!;
}

/** Cap a tier by screen resolution (a 720p screen can't show 1080p). */
export function capTierByScreen(
  tier: QualityTier,
  screenWidth: number | undefined,
  screenHeight: number | undefined,
  tiers: readonly QualityTier[] = DEFAULT_QUALITY_TIERS,
): QualityTier {
  if (!screenWidth && !screenHeight) return tier;
  const minDim = Math.min(screenWidth ?? 1920, screenHeight ?? 1080);
  const allowed: string[] = ['audio-only'];
  if (minDim >= 360) allowed.push('360p@15');
  if (minDim >= 480) allowed.push('480p@30');
  if (minDim >= 720) allowed.push('720p@30');
  if (minDim >= 1080) allowed.push('1080p@30');
  const tierIdx = tierIndex(tiers, tier.id);
  // Find the best allowed tier at or below the device tier.
  let best: QualityTier | undefined;
  for (const id of allowed) {
    const idx = tierIndex(tiers, id);
    if (idx >= 0 && idx >= tierIdx && (!best || idx < tierIndex(tiers, best.id))) best = tiers[idx];
  }
  return best ?? tier;
}

export class DeviceCapability {
  readonly profile: WireDeviceProfile;
  readonly score: number;

  private constructor(profile: WireDeviceProfile, score: number) {
    this.profile = profile;
    this.score = score;
  }

  /** Build from explicit inputs (tests, backend-provided profiles). */
  static fromInput(input: DeviceProfileInput): DeviceCapability {
    const profile: WireDeviceProfile = {
      hardwareConcurrency: input.hardwareConcurrency ?? 4,
      mobile: input.mobile ?? false,
      ...(input.deviceMemory !== undefined ? { deviceMemory: input.deviceMemory } : {}),
      ...(input.screenWidth !== undefined ? { screenWidth: input.screenWidth } : {}),
      ...(input.screenHeight !== undefined ? { screenHeight: input.screenHeight } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
    };
    return new DeviceCapability(profile, computeDeviceScore(input));
  }

  /** Detect from the environment (navigator in browsers; sane defaults in Node). */
  static detect(navigatorLike?: NavigatorLike): DeviceCapability {
    if (navigatorLike) return DeviceCapability.fromInput(readNavigator(navigatorLike));
    const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
    return DeviceCapability.fromInput(readNavigator(nav ?? { hardwareConcurrency: 4 }));
  }

  /**
   * Initial quality tier: device score + screen cap. This is the cap the app
   * applies at join (architecture.md D5a).
   */
  initialTier(tiers: readonly QualityTier[] = DEFAULT_QUALITY_TIERS): QualityTier {
    const byScore = initialTierForScore(this.score, tiers);
    return capTierByScreen(byScore, this.profile.screenWidth, this.profile.screenHeight, tiers);
  }

  /** Estimated max encode resolution/fps for this device. */
  estimateMaxResolution(): { width: number; height: number; fps: number } {
    const tier = this.initialTier();
    return { width: tier.width, height: tier.height, fps: tier.maxFramerate };
  }

  isMobile(): boolean {
    return this.profile.mobile;
  }
}

function readNavigator(nav: NavigatorLike): DeviceProfileInput {
  const ua = nav.userAgent ?? '';
  const mobile = nav.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(ua);
  return {
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    mobile,
    screenWidth: nav.screen?.width,
    screenHeight: nav.screen?.height,
    platform: 'browser',
  };
}
