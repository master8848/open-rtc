/**
 * RTCStatsSnapshot — the pure input contract of the policy engine
 * (webrtc-js.md §5.2). A snapshot is an aggregated, sanitized view of one
 * `getStats()` poll; the policy engine never touches WebRTC objects.
 */
import type { QualityWarningDirection } from '@vidcall/protocol';

export type QualityLimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other';

export interface RTCStatsSnapshot {
  /** Poll timestamp (epoch ms). Must be monotonic across ticks. */
  ts: number;
  /** Direction this snapshot describes. */
  direction?: QualityWarningDirection;
  /** candidate-pair.currentRoundTripTime × 1000. */
  rttMs?: number;
  /** candidate-pair.availableOutgoingBitrate (bps) — GCC estimate. */
  availableOutgoingBitrateBps?: number;
  /** Fraction of packets lost over the window (0..1). */
  lossRate?: number;
  /** inbound-rtp.jitter (ms). */
  jitterMs?: number;
  /** outbound-rtp.qualityLimitationReason. */
  qualityLimitationReason?: QualityLimitationReason;
  /** outbound-rtp.qualityLimitationDurations (cumulative ms per reason). */
  qualityLimitationDurationsMs?: Partial<Record<QualityLimitationReason, number>>;
  /** outbound-rtp.totalEncodeTime (cumulative ms). */
  totalEncodeTimeMs?: number;
  /** outbound-rtp.framesEncoded (cumulative). */
  framesEncoded?: number;
  /** outbound-rtp.framesPerSecond (instant). */
  framesPerSecond?: number;
  /** inbound-rtp.framesDropped (cumulative). */
  framesDropped?: number;
  /** Device capability score (0..1) from DeviceCapability — optional. */
  deviceScore?: number;
  /** Receive-side tile/view size (for receive direction). */
  viewWidth?: number;
  viewHeight?: number;
}

/** Convenience builder with sensible defaults. */
export function statsSnapshot(partial: RTCStatsSnapshot): RTCStatsSnapshot {
  return { direction: 'send', ...partial };
}
