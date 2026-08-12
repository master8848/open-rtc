/**
 * Quality tier ladder (webrtc-js.md §5.5, docs/architecture.md D5).
 *
 * Tiers are ordered high → low (index 0 = highest quality). The policy engine
 * walks this ladder: instant downgrade on congestion/CPU, 10s-stable upgrade.
 */
export interface QualityTier {
  /** Canonical id, e.g. `"1080p@30"`, `"audio-only"`. */
  id: string;
  /** Human-readable label (used in quality events). */
  label: string;
  width: number;
  height: number;
  maxFramerate: number;
  /** Encoder cap applied via setParameters (kbps). 0 = audio-only. */
  maxBitrateKbps: number;
  /** Network capacity needed to sustain this tier (kbps). */
  requiredBitrateKbps: number;
  /** Simulcast layer index (0 = highest). Undefined = single stream. */
  simulcastLayer?: number;
  degradationPreference?: 'balanced' | 'maintain-resolution' | 'maintain-framerate';
  /** True for the audio-only tier. */
  audioOnly?: boolean;
}

/** Default ladder (docs/architecture.md D5). */
export const DEFAULT_QUALITY_TIERS: readonly QualityTier[] = [
  {
    id: '1080p@30',
    label: '1080p@30',
    width: 1920,
    height: 1080,
    maxFramerate: 30,
    maxBitrateKbps: 2500,
    requiredBitrateKbps: 1800,
    simulcastLayer: 0,
    degradationPreference: 'balanced',
  },
  {
    id: '720p@30',
    label: '720p@30',
    width: 1280,
    height: 720,
    maxFramerate: 30,
    maxBitrateKbps: 1200,
    requiredBitrateKbps: 900,
    simulcastLayer: 1,
    degradationPreference: 'balanced',
  },
  {
    id: '480p@30',
    label: '480p@30',
    width: 854,
    height: 480,
    maxFramerate: 30,
    maxBitrateKbps: 600,
    requiredBitrateKbps: 450,
    simulcastLayer: 2,
    degradationPreference: 'balanced',
  },
  {
    id: '360p@15',
    label: '360p@15',
    width: 640,
    height: 360,
    maxFramerate: 15,
    maxBitrateKbps: 250,
    requiredBitrateKbps: 180,
    simulcastLayer: 2,
    degradationPreference: 'maintain-framerate',
  },
  {
    id: 'audio-only',
    label: 'audio-only',
    width: 0,
    height: 0,
    maxFramerate: 0,
    maxBitrateKbps: 0,
    requiredBitrateKbps: 0,
    audioOnly: true,
  },
];

export const AUDIO_ONLY_TIER_ID = 'audio-only';

export function findTier(tiers: readonly QualityTier[], id: string): QualityTier | undefined {
  return tiers.find((t) => t.id === id);
}

/** Index in the ladder (0 = highest). -1 if unknown. */
export function tierIndex(tiers: readonly QualityTier[], id: string): number {
  return tiers.findIndex((t) => t.id === id);
}

/** The tier one step lower (worse) than `id`, or undefined at the bottom. */
export function nextLowerTier(tiers: readonly QualityTier[], id: string): QualityTier | undefined {
  const idx = tierIndex(tiers, id);
  if (idx < 0 || idx >= tiers.length - 1) return undefined;
  return tiers[idx + 1];
}

/** The tier one step higher (better) than `id`, or undefined at the top. */
export function nextHigherTier(tiers: readonly QualityTier[], id: string): QualityTier | undefined {
  const idx = tierIndex(tiers, id);
  if (idx <= 0) return undefined;
  return tiers[idx - 1];
}
