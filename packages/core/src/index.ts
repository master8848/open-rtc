/**
 * @mbsks/openrtc-core — vidcall mesh engine.
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
export * from './e2ee.ts';
export type {
  MediaTransport,
  MediaTransportKind,
  ExtendedPublishOptions,
  MediaSubscribeOptions as MediaTransportSubscribeOptions,
  TrackSubscription as MediaTransportSubscription,
  MediaTrackEvent,
  PeerConnectionStateEvent as MediaPeerConnectionStateEvent,
} from './media/media-transport.ts';
export { ProcessorChain, type MediaProcessor, type MediaProcessorKind } from './media/processor.ts';
export { TopologyController, type Topology, type TopologyConfig } from './media/topology.ts';
export { MeshMediaTransport, type MeshMediaTransportOptions } from './media/mesh-transport.ts';
export { SfuMediaTransport, type SfuMediaTransportOptions, type SfuGatewayLike, type SfuSessionLike } from './media/sfu-transport.ts';
export { ActiveSpeakerDetector, type ActiveSpeakerEventMap, type ActiveSpeakerOptions } from './media/active-speaker.ts';
export { WhipMediaTransport, type WhipMediaTransportOptions } from './media/whip-transport.ts';
export { WhepMediaTransport, type WhepMediaTransportOptions } from './media/whep-transport.ts';
export { DenoiseProcessor, type DenoiseProcessorOptions } from './media/denoise-processor.ts';
export { VirtualBackgroundProcessor, type VirtualBackgroundProcessorOptions } from './media/virtual-background-processor.ts';
export { EgressController, type EgressOptions, type EgressHandle } from './media/egress.ts';
export { TranscriptionController, type TranscriptEvent, type TranscriptionOptions, type TranscriptionHandle } from './media/transcription.ts';

export type { Envelope } from '@mbsks/openrtc-protocol';
export { PROTOCOL_VERSION, MESSAGE_TYPES, createEnvelope, isEnvelope } from '@mbsks/openrtc-protocol';
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
  TranscriptPayload,
  ErrorPayload,
  JoinCapabilities,
} from '@mbsks/openrtc-protocol';
