/**
 * @mbsks/openrtc-quality — adaptive quality policy engine.
 *
 * Pure: consumes `RTCStatsSnapshot`s, no WebRTC imports, zero runtime deps.
 */
export * from './events.ts';
export * from './stats.ts';
export * from './tiers.ts';
export * from './device-capability.ts';
export * from './adaptive-quality-controller.ts';

export type { QualityWarningReason, QualityWarningDirection } from '@mbsks/openrtc-protocol';
