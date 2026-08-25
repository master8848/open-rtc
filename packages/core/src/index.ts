/**
 * @vidcall/core — vidcall mesh engine.
 *
 * Zero runtime dependencies: builds on the platform `RTCPeerConnection`
 * (browser WebRTC, werift/wrtc in Node, or injected fakes in tests).
 */
export * from './events.ts';
export * from './transport.ts';
export * from './ordering.ts';
export * from './sdp.ts';
export * from './peer-connection-manager.ts';
export * from './data-channel-bus.ts';
export * from './participants.ts';
export * from './room.ts';
export * from './store.ts';
export * from './devices.ts';
export * from './controls/index.ts';
export * from './room-quality.ts';
export * from './recording/index.ts';

export type { Envelope } from '@vidcall/protocol';
export { PROTOCOL_VERSION, MESSAGE_TYPES, createEnvelope, isEnvelope } from '@vidcall/protocol';
export type {
  MessageType,
  DeviceProfile,
  JoinPayload,
  LeavePayload,
  OfferPayload,
  IcePayload,
  PresencePayload,
  PresenceState,
  ReactionPayload,
  ChatPayload,
  ScreenSharePayload,
  QualityWarningPayload,
  QualityWarningReason,
  QualityWarningDirection,
  SfuPayload,
  ErrorPayload,
  JoinCapabilities,
} from '@vidcall/protocol';
