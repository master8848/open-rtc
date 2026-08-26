import type { Envelope } from '@mbsks/openrtc-protocol';
import type { TrackPublication } from '../participants.ts';

export type MediaTransportKind = 'mesh' | 'sfu' | 'whip' | 'whep' | 'custom';

export interface SimulcastOptions {
  layers?: number;
  encodings?: RTCRtpEncodingParameters[];
}

export interface SvcOptions {
  scalabilityMode?: string;
}

export interface ExtendedPublishOptions {
  source?: TrackPublication['source'];
  metadata?: Record<string, unknown>;
  simulcast?: SimulcastOptions | boolean;
  svc?: SvcOptions;
  codecPreferences?: string[];
}

export interface MediaSubscribeOptions {
  kind?: 'audio' | 'video';
  layer?: string;
}

export interface TrackSubscription {
  participantId: string;
  readonly publication: TrackPublication | undefined;
  setEnabled(enabled: boolean): void;
  close(): void;
}

export interface MediaTrackEvent {
  participantId: string;
  track: MediaStreamTrack;
  kind: 'audio' | 'video';
  publicationId?: string;
}

export interface PeerConnectionStateEvent {
  participantId: string;
  state: RTCPeerConnectionState;
}

export interface MediaTransport {
  readonly kind: MediaTransportKind;
  publish(track: MediaStreamTrack, opts?: ExtendedPublishOptions): Promise<TrackPublication>;
  unpublish(pub: TrackPublication): Promise<void>;
  subscribe(participantId: string, opts?: MediaSubscribeOptions): Promise<TrackSubscription>;
  setPreferredLayers?(trackId: string, layer: string): Promise<void>;
  requestKeyframe?(trackId: string): Promise<void>;
  restartIce?(participantId?: string): Promise<void>;
  getSenders(): RTCRtpSender[];
  getPeerConnections(): RTCPeerConnection[];
  getPeerConnection?(participantId: string): RTCPeerConnection | undefined;
  getDataChannelBus?(participantId: string): unknown;
  onTrack(cb: (e: MediaTrackEvent) => void): () => void;
  onConnectionState?(cb: (e: PeerConnectionStateEvent) => void): () => void;
  handleEnvelope?(envelope: Envelope): Promise<boolean>;
  handleSfuEnvelope?(envelope: Envelope): Promise<boolean>;
  close(): Promise<void>;
}
