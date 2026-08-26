/**
 * @mbsks/openrtc-sfu-gateway — SfuGateway contract.
 *
 * The engine stays mesh-first (docs/architecture.md D2); this interface is
 * the optional path to a selective-forwarding unit (SFU) at scale. It is
 * deliberately **not** mediasoup's or LiveKit's wire protocol: vidcall's own
 * small contract, so any SFU (mediasoup, LiveKit, Janus, custom) can be
 * adapted behind it (docs/research/webrtc-js.md §3.3).
 *
 * The gateway is transport-agnostic and media-agnostic: it never touches
 * `RTCPeerConnection` or tracks. Media negotiation flows through as opaque
 * SDP offers/answers and ICE candidates (`handleOffer`/`handleAnswer`/
 * `addIceCandidate`), which the adapter translates onto its SFU.
 *
 * Lifecycle (Room wires this via SfuMediaTransport):
 * ```
 * const session = await gateway.join(roomId, participantId, { transportOpts });
 * // sfu envelope {action:'publish', trackId, kind}  -> session.publishTrack(...)
 * // sfu envelope {action:'subscribe', senderId}     -> session.subscribe(...)
 * // offer/answer/ice envelope addressed to the SFU  -> session.handle*()
 * // sfu envelope {action:'leave'}                   -> session.leave()
 * ```
 */
import type { IcePayload, OfferPayload, SfuKind } from '@mbsks/openrtc-protocol';

/**
 * Transport parameters handed to the gateway at `join`. Adapters map these
 * onto their SFU transport (mediasoup: `createWebRtcTransport` options such
 * as `listenIps`/`enableUdp`/`enableTcp`/`enableSctp`). Unknown keys are
 * forwarded as-is to the adapter, so it can grow without protocol changes.
 */
export interface SfuTransportOptions {
  /** Enable ICE for the transport (mediasoup: `enableUdp`/`enableTcp`). */
  ice?: boolean;
  /** Enable DTLS for the transport. */
  dtls?: boolean;
  /** Enable SCTP data channels on the transport. */
  sctp?: boolean;
  /** Adapter-specific transport options (e.g. mediasoup `listenIps`). */
  [key: string]: unknown;
}

/** Options for `SfuGateway.join`. */
export interface SfuJoinOptions {
  /** Adapter-specific transport parameters. */
  transportOpts?: SfuTransportOptions;
  /** Client capability hints from the join envelope (`simulcast`/`svc`/`codecs`). */
  capabilities?: {
    simulcast?: boolean;
    svc?: boolean;
    codecs?: string[];
  };
}

/** Options for `SfuSession.publishTrack`. */
export interface PublishOptions {
  /** Ask for send-side simulcast (adapter maps this to encodings). */
  simulcast?: boolean;
  /** Adapter-specific encoding hints (mediasoup `encodings`). */
  encodings?: Array<Record<string, unknown>>;
  /**
   * Adapter hint: delay (ms) before the SFU asks the sender for a new key
   * frame after a previous request (mediasoup `ProducerOptions.keyFrameRequestDelay`,
   * video only; default 0). Ignored by adapters without an equivalent.
   */
  keyFrameRequestDelayMs?: number;
}

/** Unified video quality for SFU layer selection (TanStack explicit). */
export const VideoQuality = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  /** Short aliases for simulcast layers (mediasoup `l`/`m`/`h`). */
  L: 'l',
  M: 'm',
  H: 'h',
} as const;

export type VideoQuality = (typeof VideoQuality)[keyof typeof VideoQuality];

/** Options for `SfuSession.subscribe`. */
export interface SubscribeOptions {
  /** Preferred layers for the subscription (see `VideoQuality`). */
  layers?: (VideoQuality | string)[];
}

/**
 * A remote track event observed by the gateway (published or subscribed).
 * `publicationId` is the adapter-specific producer/consumer id — other
 * participants need the producer id to subscribe to a published track.
 */
export interface SfuTrackEvent {
  roomId: string;
  /** Participant that owns the track (sender for 'send', receiver for 'receive'). */
  participantId: string;
  /** vidcall track id (from the publish envelope). */
  trackId: string;
  kind: SfuKind;
  direction: 'send' | 'receive';
  /** Adapter-specific producer (send) or consumer (receive) id. */
  publicationId: string;
  /** Current layer for receive-side tracks (simulcast/SVC), if known. */
  layer?: string;
}

/**
 * One participant's media session on the SFU, created by `SfuGateway.join`.
 * Methods mirror the protocol's `SfuPayload` actions:
 *
 * | protocol action      | method                       |
 * | -------------------- | ---------------------------- |
 * | `publish`            | `publishTrack`               |
 * | `subscribe`          | `subscribe`                  |
 * | `layer-change`       | `setPreferredLayers`         |
 * | `keyframe-request`   | `requestKeyframe`            |
 * | `leave`              | `leave`                      |
 *
 * SDP offers/answers and ICE candidates are passed through unchanged — the
 * gateway is media-agnostic by design.
 */
export interface SfuSession {
  readonly roomId: string;
  readonly participantId: string;

  /**
   * Announce a track for publishing. The adapter wires it to the SFU once the
   * client's SDP offer carrying the m-line arrives (`handleOffer`).
   */
  publishTrack(trackId: string, kind: SfuKind, opts?: PublishOptions): Promise<void>;

  /** Subscribe to a remote participant's published tracks. */
  subscribe(participantId: string, opts?: SubscribeOptions): Promise<void>;

  /** Prefer a specific simulcast/SVC layer (see `VideoQuality`). */
  setPreferredLayers(trackId: string, layer: VideoQuality | string): Promise<void>;

  /** Ask the sender for a keyframe for a track (recovery after layer switch). */
  requestKeyframe(trackId: string): Promise<void>;

  /** Feed the client's SDP offer through (adapter answers via its `onAnswer` hook). */
  handleOffer(offer: OfferPayload): Promise<void>;

  /** Feed the client's SDP answer through. */
  handleAnswer(answer: OfferPayload): Promise<void>;

  /** Trickle an ICE candidate from the client to the SFU transport. */
  addIceCandidate(candidate: IcePayload): Promise<void>;

  /** Tear down this session's media on the SFU. */
  leave(): Promise<void>;
}

export interface SfuEgressOptions {
  hls?: boolean;
  rtmpUrl?: string;
  whep?: boolean;
}

export interface SfuEgressHandle {
  hlsUrl?: string;
  whepUrl?: string;
  stop(): Promise<void>;
}

/**
 * The optional SFU adapter surface. Mesh stays the default; apps opt in by
 * constructing a gateway (see the mediasoup reference adapter) and wiring it
 * into a `Room` (parent task: Room integration).
 */
export interface SfuGateway {
  /**
   * Open an SFU session for `participantId` in `roomId` (creates the media
   * transport). Call once per participant, before routing sfu envelopes.
   */
  join(roomId: string, participantId: string, opts?: SfuJoinOptions): Promise<SfuSession>;

  /** Observe track events across all sessions. Returns an unsubscribe fn. */
  onTrack(cb: (event: SfuTrackEvent) => void): () => void;

  /** Close every session, or only the sessions of one room. */
  close(roomId?: string): Promise<void>;

  /** Start SFU egress (PlainTransport -> ffmpeg -> RecordingStorage/HLS/RTMP). */
  egress?(roomId: string, opts: SfuEgressOptions): Promise<SfuEgressHandle>;

  /** Stop egress for a room. */
  stopEgress?(roomId: string): Promise<void>;
}

/** Convenience key for `(roomId, participantId)` pairs. */
export function sessionKey(roomId: string, participantId: string): string {
  return `${roomId}\u0000${participantId}`;
}
