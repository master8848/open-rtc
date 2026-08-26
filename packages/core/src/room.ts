/**
 * Room — the vidcall public API (docs/architecture.md §2, D2/D3/D6).
 *
 * A `Room` connects one local participant to a mesh of remote participants
 * over a `SignalingTransport`. Media flows over per-participant
 * `RTCPeerConnection`s managed by `PeerConnectionManager` (perfect
 * negotiation, trickle ICE, renegotiation, ICE restart); reactions/chat flow
 * over the backend pub/sub and/or per-peer `DataChannelBus`es.
 *
 * ```ts
 * const room = new Room({ roomId, selfId, transport });
 * room.on('track', ({ participant, track }) => { /* attach to <video> *\/ });
 * room.on('participant-joined', (p) => console.log('hi', p.id));
 * await room.join();
 * await room.publish(await getUserMedia({ video: true }).then(s => s.getVideoTracks()[0]));
 * ```
 */
import type {
  ChatPayload,
  DeviceProfile,
  Envelope,
  IcePayload,
  JoinCapabilities,
  JoinPayload,
  OfferPayload,
  PresenceState,
  QualityWarningPayload,
  ReactionPayload,
  ScreenSharePayload,
  TranscriptPayload,
} from '@mbsks/openrtc-protocol';
import { TypedEmitter } from './events.ts';
import { OrderedMessageBuffer } from './ordering.ts';
import { LocalParticipant, RemoteParticipant } from './participants.ts';
import type { TrackPublication } from './participants.ts';

import { RoomQualityController, qualityEnvironmentSupported } from './room-quality.ts';
import type {
  LocalQualityChangedEvent,
  LocalQualityWarningEvent,
  RoomQualityConfig,
  RoomQualityHost,
} from './room-quality.ts';
import type { ParticipantInfo, SignalingTransport } from './transport.ts';
import { SFrameProcessor, detectE2eeSupport } from './e2ee.ts';
import type { MediaTransport } from './media/media-transport.ts';
import type { ExtendedPublishOptions } from './media/media-transport.ts';
import { MeshMediaTransport } from './media/mesh-transport.ts';
import { SfuMediaTransport, type SfuGatewayLike } from './media/sfu-transport.ts';
import { ProcessorChain, type MediaProcessor } from './media/processor.ts';
import { TopologyController, type Topology, type TopologyConfig } from './media/topology.ts';
import { ActiveSpeakerDetector } from './media/active-speaker.ts';
import { EgressController, type EgressOptions } from './media/egress.ts';
import { TranscriptionController, type TranscriptEvent, type TranscriptionOptions } from './media/transcription.ts';
// CompositeTransport is the canonical dual-path transport (see packages/transport/src/composite.ts).
// Room uses it for `transport: [primary, fallback]` array sugar. Decision: direct import adds
// @mbsks/openrtc-transport as a runtime dep to core (previously zero 3rd-party deps). Kept as
// package import; for `tsc -b` local check we suppress resolution until transport is built.
// @ts-ignore - resolved via package exports after build
import { CompositeTransport } from '@mbsks/openrtc-transport/composite';
import type { MediaRecorderConstructor } from './recording/media-recorder-recording-hook.ts';
import type {
  RecordingChunk,
  RecordingErrorEvent,
  RecordingStartedEvent,
  RecordingStoppedEvent,
} from './recording/recording-hook.ts';
import type { RecordingFetch } from './recording/recording-uploader.ts';
import { FetchRecordingUploader } from './recording/recording-uploader.ts';
import { RoomRecordingFacade } from './recording/room-recording-facade.ts';
import { RoomDevicesFacade } from './devices.ts';
import type { MediaDevicesLike } from './devices.ts';
import {
  ObservableStore,
  buildRoomSnapshot,
  roomSnapshotsEqual,
  type RoomSnapshot,
} from './store.ts';

// ------------------------------------------------------------------ events

export interface RemoteTrackEvent {
  participant: RemoteParticipant;
  publication: TrackPublication;
  track: MediaStreamTrack;
}

export interface PeerConnectionStateEvent {
  participantId: string;
  state: RTCPeerConnectionState;
}

export interface PeerIceConnectionStateEvent {
  participantId: string;
  state: RTCIceConnectionState;
}

/**
 * Reaction/chat/... events carry both `participantId` (canonical) and
 * `senderId` (alias for backward compat). New code should use
 * `participantId`; `senderId` is kept as a deprecated alias with identical
 * value.
 */
export interface RoomReactionEvent extends ReactionPayload {
  /** Canonical participant id (alias `senderId` kept for compat). */
  participantId: string;
  /** @deprecated Alias for `participantId` */
  senderId: string;
}

export interface RoomChatEvent extends ChatPayload {
  participantId: string;
  /** @deprecated Alias for `participantId` */
  senderId: string;
}

export interface RoomScreenShareEvent extends ScreenSharePayload {
  participantId: string;
  /** @deprecated Alias for `participantId` */
  senderId: string;
}

export interface RoomQualityWarningEvent extends QualityWarningPayload {
  participantId: string;
  /** @deprecated Alias for `participantId` */
  senderId: string;
}

export interface RoomTranscriptEvent extends TranscriptPayload {
  participantId: string;
  /** @deprecated Alias for `participantId` */
  senderId: string;
  isFinal: boolean;
}

/** Canonical kebab-style events (colon aliases kept for backward compat). */
export type RoomCanonicalEventMap = {
  /** A remote participant announced their join. */
  'participant-joined': [RemoteParticipant];
  /** A remote participant left (leave envelope or presence offline). */
  'participant-left': [RemoteParticipant];
  /** A remote participant updated join metadata. */
  'participant-updated': [RemoteParticipant];
  /** A remote media track arrived (subscribe in mesh is automatic). */
  track: [RemoteTrackEvent];
  /** A remote media track ended/was unpublished. */
  'track-unpublished': [RemoteTrackEvent];
  /** Aggregate connection state for a peer changed. */
  'connection-state': [PeerConnectionStateEvent];
  'ice-connection-state': [PeerIceConnectionStateEvent];
  /** Reaction received (backend broadcast and/or data channel). */
  reaction: [RoomReactionEvent];
  /** Chat message received. */
  chat: [RoomChatEvent];
  'screen-share': [RoomScreenShareEvent];
  /** Remote quality warning envelope. */
  'quality-warning': [RoomQualityWarningEvent];
  transcript: [RoomTranscriptEvent];
  /** Active speaker list changed (polls inbound-rtp audioLevel). */
  'active-speaker': [string[]];
  /**
   * Local adaptive-quality tier changed (tier, reason, direction, metrics).
   * Canonical kebab; `quality:changed` is an alias.
   */
  'quality-changed': [LocalQualityChangedEvent];
  /**
   * Local adaptive-quality warning: `code` is one of 'cpu-high' |
   * 'network-degraded' | 'uplink-starved' | 'device-capped' | 'recovered' |
   * 'manual' | 'monitor-error'. Canonical `local-quality-warning` (aliases
   * `quality:warning` and `quality-warning-local`) to avoid collision with the
   * remote `quality-warning` envelope.
   */
  'local-quality-warning': [LocalQualityWarningEvent];
  /** Presence update from the backend presence layer. */
  presence: [ParticipantInfo & { state: PresenceState }];
  error: [Error];
  /** Emitted once after `leave()`/`close()` completes. */
  closed: [];
  /** Topology transport changed (mesh↔sfu) after `maybeMigrate` or `setTopology`. */
  'topology-changed': [{ from: string; to: string }];
  /** Recording facade events (see `room.recording`). */
  'recording-started': [RecordingStartedEvent];
  'recording-stopped': [RecordingStoppedEvent];
  'recording-error': [RecordingErrorEvent];
  'recording-blob-chunk': [RecordingChunk];
  /** The platform reported a change in connected media devices (see `room.devices`). */
  'devices-changed': [];
  /** E2EE events (see `room.e2ee`). */
  'e2ee-key-rotated': [];
  'e2ee-error': [Error];
  'e2ee-warning': [{ code: string; message: string }];
  /** Auth failure (WS 4401 mapped): token expired/invalid. */
  'auth-error': [Error];
};

/** Deprecated colon/delimited aliases — kept for backward compat. */
export type RoomEventAliases = {
  /** @deprecated Use `quality-changed` */
  'quality:changed': [LocalQualityChangedEvent];
  /** @deprecated Use `local-quality-warning` */
  'quality:warning': [LocalQualityWarningEvent];
  /** @deprecated Alias for `local-quality-warning` */
  'quality-warning-local': [LocalQualityWarningEvent];
  /** @deprecated Use `recording-started` */
  'recording:started': [RecordingStartedEvent];
  /** @deprecated Use `recording-stopped` */
  'recording:stopped': [RecordingStoppedEvent];
  /** @deprecated Use `recording-error` */
  'recording:error': [RecordingErrorEvent];
  /** @deprecated Use `recording-blob-chunk` */
  'recording:blob-chunk': [RecordingChunk];
  /** @deprecated Use `devices-changed` */
  'devices:changed': [];
  /** @deprecated Use `e2ee-key-rotated` */
  'e2ee:key-rotated': [];
  /** @deprecated Use `e2ee-error` */
  'e2ee:error': [Error];
  /** @deprecated Use `e2ee-warning` */
  'e2ee:warning': [{ code: string; message: string }];
  /** @deprecated Use `auth-error` */
  'auth:error': [Error];
};

export type RoomEventMap = RoomCanonicalEventMap & RoomEventAliases;

/** Linear SDK style typed event names — single source for canonical kebab values. */
export const RoomEvent = {
  ParticipantJoined: 'participant-joined',
  ParticipantLeft: 'participant-left',
  ParticipantUpdated: 'participant-updated',
  Track: 'track',
  TrackUnpublished: 'track-unpublished',
  ConnectionState: 'connection-state',
  IceConnectionState: 'ice-connection-state',
  Reaction: 'reaction',
  Chat: 'chat',
  ScreenShare: 'screen-share',
  QualityWarning: 'quality-warning',
  Transcript: 'transcript',
  ActiveSpeaker: 'active-speaker',
  QualityChanged: 'quality-changed',
  LocalQualityWarning: 'local-quality-warning',
  Presence: 'presence',
  Error: 'error',
  Closed: 'closed',
  TopologyChanged: 'topology-changed',
  RecordingStarted: 'recording-started',
  RecordingStopped: 'recording-stopped',
  RecordingError: 'recording-error',
  RecordingBlobChunk: 'recording-blob-chunk',
  DevicesChanged: 'devices-changed',
  E2eeKeyRotated: 'e2ee-key-rotated',
  E2eeError: 'e2ee-error',
  E2eeWarning: 'e2ee-warning',
  AuthError: 'auth-error',
} as const;

export type RoomEventName = (typeof RoomEvent)[keyof typeof RoomEvent];

/** Map colon aliases to canonical kebab for runtime compat. */
export const ROOM_EVENT_ALIASES: Readonly<Record<string, string>> = {
  'quality:changed': 'quality-changed',
  'quality:warning': 'local-quality-warning',
  'quality-warning-local': 'local-quality-warning',
  'recording:started': 'recording-started',
  'recording:stopped': 'recording-stopped',
  'recording:error': 'recording-error',
  'recording:blob-chunk': 'recording-blob-chunk',
  'devices:changed': 'devices-changed',
  'e2ee:key-rotated': 'e2ee-key-rotated',
  'e2ee:error': 'e2ee-error',
  'e2ee:warning': 'e2ee-warning',
  'auth:error': 'auth-error',
} as const;

/** Canonicalize an event name (alias -> kebab). */
export function canonicalRoomEvent(event: string): string {
  return ROOM_EVENT_ALIASES[event] ?? event;
}

// ------------------------------------------------------------------ config

export interface PublishOptions {
  source?: TrackPublication['source'];
  metadata?: Record<string, unknown>;
  simulcast?: { layers?: number; encodings?: RTCRtpEncodingParameters[] } | boolean;
  svc?: { scalabilityMode?: string };
  codecPreferences?: string[];
}

export interface JoinOptions {
  /**
   * Cancellation for an in-flight join (docs/reviews/perspective-tanstack.md
   * roadmap #8). When the signal aborts, `join()` stops at the next step,
   * rolls back any subscriptions it registered and releases the transport
   * session again — the room stays unjoined and `join()` may be retried
   * (e.g. a React `<StrictMode>` double-mount). Already-joined rooms ignore
   * the signal. Rejected with `signal.reason` (default: an AbortError).
   */
  signal?: AbortSignal;
}

export interface MediaSubscribeOptions {
  /** Restrict the handle to one track kind (default: all kinds). */
  kind?: 'audio' | 'video';
}

export interface TrackSubscription {
  participantId: string;
  /** First matching remote publication (undefined until a track arrives). */
  readonly publication: TrackPublication | undefined;
  /** Enable/disable decoding of the subscribed tracks (mesh: track.enabled). */
  setEnabled(enabled: boolean): void;
  close(): void;
}

export interface RoomDevicesConfig {
  /**
   * `navigator.mediaDevices` provider for the devices facade (default:
   * platform). Tests inject fakes; `null` forces the "unavailable" state.
   */
  mediaDevices?: MediaDevicesLike | null;
}

export interface RoomAuthConfig {
  /** Current token (used for `Authorization`/WS `?token=` and TURN fetch). */
  token?: string;
  /** Called when the server signals auth failure (4401). Should return a fresh token. */
  onTokenExpired?: () => string | Promise<string>;
  /** Optional TURN credentials fetcher (e.g. fetch('/turn/credentials')). */
  getTurnCredentials?: () => Promise<RTCIceServer[]>;
}

export interface RoomE2eeConfig {
  /** App-provided key (raw bytes or CryptoKey). When present, E2EE is enabled. */
  key: CryptoKey | Uint8Array;
  /** When true, refuse to publish/join without a working transform. */
  required?: boolean;
}

export interface ReconnectConfig {
  maxAttempts?: number;
  backoffMs?: number;
  coalesceIceMs?: number;
}

/** Grouped RTC options (canonical). Flat `iceServers`/`polite`/etc remain as aliases for compat. */
export interface RoomRtcOptions {
  iceServers?: RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>);
  polite?: boolean | ((selfId: string, remoteId: string) => boolean);
  autoRestartIce?: boolean;
  dataChannelName?: string;
  peerFactory?: (participantId: string) => RTCPeerConnection;
}

/** Publish defaults grouped (TanStack `publishDefaults` pattern). */
export interface RoomPublishDefaults {
  simulcast?: PublishOptions['simulcast'];
  svc?: PublishOptions['svc'];
  codecPreferences?: string[];
}

/** Adaptive/quality grouping. */
export interface RoomAdaptiveOptions {
  mode?: 'auto' | 'manual' | 'disabled';
}

/** Canonical SFU grouping. */
export interface RoomSfuOptions {
  gateway?: SfuGatewayLike;
}

export interface RoomConfig {
  roomId: string;
  selfId: string;
  displayName?: string;
  /** Per-join id; guards against stale tabs/duplicates. Default: random. */
  sessionId?: string;
  metadata?: Record<string, unknown>;
  deviceProfile?: DeviceProfile;
  capabilities?: JoinCapabilities;
  /** Single transport or array sugar `[primary, fallback]` → CompositeTransport. */
  transport: SignalingTransport | SignalingTransport[];
  /** Optional reconnect wrapper opts (maxAttempts, backoffMs). When set, transport is wrapped in ReconnectingTransport. */
  reconnect?: ReconnectConfig;
  // --- grouped options (canonical) ---
  /** @deprecated Use `rtc.peerFactory`. */
  peerFactory?: (participantId: string) => RTCPeerConnection;
  /** @deprecated Use `rtc.iceServers`. */
  iceServers?: RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>);
  /** @deprecated Use `rtc.polite`. */
  polite?: boolean | ((selfId: string, remoteId: string) => boolean);
  /** @deprecated Use `rtc.autoRestartIce`. */
  autoRestartIce?: boolean;
  /** @deprecated Use `rtc.dataChannelName`. */
  dataChannelName?: string;
  /** Canonical RTC grouping. Flat fields above remain as aliases. */
  rtc?: RoomRtcOptions;
  /** Default publish options applied when `publish()` is called without explicit overrides. */
  publishDefaults?: RoomPublishDefaults;
  /** Adaptive quality grouping. */
  adaptive?: RoomAdaptiveOptions;
  /** Canonical SFU config. */
  sfu?: RoomSfuOptions;
  /**
   * Base URL of the vidcall server's recording endpoint. When set, the room's
   * recording facade uploads chunks + finalize reports there via
   * `FetchRecordingUploader` (no dependency on the server package).
   * @deprecated Use `recording.endpoint`.
   */
  recordingEndpoint?: string;
  /**
   * fetch implementation for the recording uploader (default: global fetch).
   * Pass `null` to force the "no fetch available" path. Tests inject mocks.
   */
  recordingFetchImpl?: RecordingFetch | null;
  /**
   * MediaRecorder constructor for the recording facade (default: platform
   * `MediaRecorder`). Tests inject fakes; `null` forces the unavailable state.
   */
  recordingMediaRecorderCtor?: MediaRecorderConstructor | null;
  /**
   * Devices facade configuration (`room.devices`): enumerate/switch/restart
   * local media devices, with `devices:changed` events.
   */
  devices?: RoomDevicesConfig;
  /**
   * Adaptive-quality wiring (docs/architecture.md D5). Default: enabled in
   * browsers, auto-disabled in non-browser/test environments (guarded like
   * recording — `room.quality` stays defined and inert when unavailable).
   *
   * ```ts
   * const room = new Room({
   *   roomId, selfId, transport,
   *   quality: { intervalMs: 2000, simulcast: false },
   * });
   * room.on('quality:changed', ({ from, to, reason, stats }) => { ... });
   * room.on('quality:warning', ({ code, message, level }) => { ... });
   * ```
   */
  quality?: RoomQualityConfig;
  /** Auth (token + refresh hook + TURN). */
  auth?: RoomAuthConfig;
  /** E2EE (SFrame). */
  e2ee?: RoomE2eeConfig | false;
  topology?: TopologyConfig;
  /** @deprecated Use `sfu.gateway`. Triple alias: sfuGateway | topology.sfu.gateway | sfu.gateway. */
  sfuGateway?: SfuGatewayLike;
  mediaTransport?: MediaTransport;
  /** Recording (unified surface per 02-recording.md; keeps backward compat with recordingEndpoint). */
  recording?: {
    mode?: 'client' | 'sfu-selective' | 'sfu-composite';
    endpoint?: string;
    mimeType?: string;
    timesliceMs?: number;
    encryption?: { key: CryptoKey; keyId?: string } | false;
  };
  debug?: (message: string, data?: unknown) => void;
}

/** Builder for `RoomConfig` — groups sprawl into `rtc`/`publishDefaults`/`adaptive`/`sfu`/`recording`. */
export class RoomOptionsBuilder {
  private opts: Partial<RoomConfig> & Pick<RoomConfig, 'roomId' | 'selfId' | 'transport'>;

  constructor(base: Pick<RoomConfig, 'roomId' | 'selfId' | 'transport'> & Partial<RoomConfig>) {
    this.opts = { ...base };
  }

  rtc(rtc: RoomRtcOptions): this {
    this.opts.rtc = { ...(this.opts.rtc ?? {}), ...rtc };
    return this;
  }

  publishDefaults(defaults: RoomPublishDefaults): this {
    this.opts.publishDefaults = { ...(this.opts.publishDefaults ?? {}), ...defaults };
    return this;
  }

  adaptive(adaptive: RoomAdaptiveOptions): this {
    this.opts.adaptive = { ...(this.opts.adaptive ?? {}), ...adaptive };
    return this;
  }

  sfu(sfu: RoomSfuOptions): this {
    this.opts.sfu = { ...(this.opts.sfu ?? {}), ...sfu };
    return this;
  }

  recording(recording: NonNullable<RoomConfig['recording']>): this {
    this.opts.recording = { ...(this.opts.recording ?? {}), ...recording };
    return this;
  }

  quality(quality: RoomQualityConfig): this {
    this.opts.quality = { ...(this.opts.quality ?? {}), ...quality };
    return this;
  }

  auth(auth: RoomAuthConfig): this {
    this.opts.auth = { ...(this.opts.auth ?? {}), ...auth };
    return this;
  }

  topology(topology: TopologyConfig): this {
    this.opts.topology = { ...(this.opts.topology ?? {}), ...topology };
    return this;
  }

  build(): RoomConfig {
    return this.opts as RoomConfig;
  }
}

/** Helper — create a `RoomConfig` with grouped defaults merged (keeps flat aliases for compat). */
export function createRoomOptions(
  base: Pick<RoomConfig, 'roomId' | 'selfId' | 'transport'> & Partial<RoomConfig>,
): RoomConfig {
  return new RoomOptionsBuilder(base).build();
}

// ------------------------------------------------------------------- room

export class Room extends TypedEmitter<RoomEventMap> implements RoomQualityHost {
  // --- event alias compat: colon -> kebab canonical (see ROOM_EVENT_ALIASES) ---
  override on<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): () => void {
    return super.on(canonicalRoomEvent(event as string) as K, listener as unknown as (...args: unknown[]) => void);
  }
  override once<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): () => void {
    return super.once(canonicalRoomEvent(event as string) as K, listener as unknown as (...args: unknown[]) => void);
  }
  override off<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): void {
    super.off(canonicalRoomEvent(event as string) as K, listener as unknown as (...args: unknown[]) => void);
  }
  override emit<K extends keyof RoomEventMap>(event: K, ...args: RoomEventMap[K]): boolean {
    return super.emit(canonicalRoomEvent(event as string) as K, ...(args as unknown[] as RoomEventMap[K]));
  }
  override listenerCount(event: keyof RoomEventMap): number {
    return super.listenerCount(canonicalRoomEvent(event as string) as keyof RoomEventMap);
  }
  override removeAllListeners(event?: keyof RoomEventMap): void {
    if (event === undefined) super.removeAllListeners();
    else super.removeAllListeners(canonicalRoomEvent(event as string) as keyof RoomEventMap);
  }

  readonly roomId: string;
  readonly local: LocalParticipant;
  readonly sessionId: string;
  /**
   * Recording facade (D6): composite MediaRecorder recording of the local and
   * remote streams with an optional server upload.
   *
   * ```ts
   * room.recording.on('recording:blob-chunk', (chunk) => { ... });
   * await room.recording.startRecording({
   *   localStream, // composed local camera+mic stream
   *   remoteStreams: [{ participantId: 'alice', stream: aliceStream }],
   * });
   * // ... later
   * await room.recording.stopRecording(); // complete Blobs + finalize report
   * ```
   *
   * The facade re-emits 'recording:started' / 'recording:stopped' /
   * 'recording:error' / 'recording:blob-chunk' on the room itself.
   * `leave()` stops any in-progress recording (uploading the finalize report).
   */
  readonly recording: RoomRecordingFacade;
  /**
   * Devices facade (local media-device management).
   *
   * ```ts
   * const cameras = await room.devices.listDevices('videoinput');
   * await room.devices.switchCamera(); // user <-> environment
   * await room.devices.restartTrack('audio', { deviceId: 'mic-2' });
   * room.on('devices:changed', () => void room.devices.listDevices());
   * ```
   *
   * Platform-guarded: in environments without `navigator.mediaDevices`
   * `listDevices` resolves `[]`, `switchCamera`/`setFacingMode` resolve
   * `false`, and `restartTrack` rejects with `DevicesUnavailableError`.
   * `leave()` releases the `devicechange` subscription.
   */
  readonly devices: RoomDevicesFacade;
  /**
   * Adaptive-quality controller (D5): samples `getStats()`, feeds the policy
   * ladder, and applies tier changes to the local video senders. Inert when
   * the environment lacks a browser WebRTC stack (see `available`).
   * Re-emits 'quality:changed' / 'quality:warning' on the room.
   */
  readonly quality: RoomQualityController;
  private readonly config: RoomConfig;
  private readonly transport: SignalingTransport;
  private readonly remoteById = new Map<string, RemoteParticipant>();
  private readonly buffer = new OrderedMessageBuffer();
  private readonly unsubscribers: (() => void)[] = [];
  private seq = 0;
  private joined = false;
  private joining = false;
  private closed = false;
  private e2eeProcessor: SFrameProcessor | null = null;
  private pendingIceServers: RTCIceServer[] | null = null;
  private authRefreshInFlight: Promise<string | null> | null = null;
  /** Serializes concurrent `join()` calls so retries start after settle. */
  private joinChain: Promise<unknown> = Promise.resolve();
  private readonly snapshotStore: ObservableStore<RoomSnapshot>;
  /**
   * Fast path for emitter-only users: with zero snapshot subscribers we only
   * mark dirty and rebuild lazily on the next `getSnapshot()`.
   */
  private snapshotDirty = false;
  private media!: MediaTransport;
  private readonly processorChain: ProcessorChain;
  private readonly topologyController: TopologyController;
  private readonly activeSpeaker: ActiveSpeakerDetector;
  private readonly egress: EgressController;
  private readonly transcription: TranscriptionController;

  constructor(config: RoomConfig) {
    super();
    this.config = this.normalizeConfig(config);
    this.roomId = this.config.roomId;
    // array sugar: [primary, fallback] → CompositeTransport (canonical from @mbsks/openrtc-transport)
    // Decision: direct import adds @mbsks/openrtc-transport dep to core (was zero-deps). Trade-off: dedup logic now single-sourced
    // in packages/transport/src/composite.ts; core no longer carries an inline copy. Zero-deps claim now excludes transport (still no 3rd-party).
    if (Array.isArray(this.config.transport)) {
      const arr = this.config.transport as SignalingTransport[];
      if (arr.length === 0) throw new Error('Room: transport array must not be empty');
      if (arr.length === 1) this.transport = arr[0]!;
      else {
        const [primary, fallback] = arr as [SignalingTransport, SignalingTransport];
        this.transport = new CompositeTransport(primary, fallback);
      }
    } else {
      this.transport = this.config.transport as SignalingTransport;
    }
    this.sessionId = this.config.sessionId ?? randomId();
    this.local = new LocalParticipant({
      id: this.config.selfId,
      displayName: this.config.displayName,
      metadata: this.config.metadata,
      deviceProfile: this.config.deviceProfile,
      capabilities: this.config.capabilities,
    });
    const recEndpoint = this.config.recording?.endpoint ?? this.config.recordingEndpoint;
    this.recording = new RoomRecordingFacade({
      roomId: this.roomId,
      sessionId: this.sessionId,
      uploader: recEndpoint
        ? new FetchRecordingUploader({
            endpoint: recEndpoint,
            fetchImpl: this.config.recordingFetchImpl,
          })
        : undefined,
      timesliceMs: this.config.recording?.timesliceMs,
      mediaRecorderCtor: this.config.recordingMediaRecorderCtor,
      debug: this.debug,
    });
    // Re-emit facade events on the room (facade still uses colon, Room canonical is kebab — alias mapping handles both).
    this.recording.on('recording:started', (event) => (this as any).emit('recording-started', event));
    this.recording.on('recording:stopped', (event) => (this as any).emit('recording-stopped', event));
    this.recording.on('recording:error', (event) => (this as any).emit('recording-error', event));
    this.recording.on('recording:blob-chunk', (chunk) => (this as any).emit('recording-blob-chunk', chunk));
    // Adaptive quality (D5): construct the controller (inert when disabled or
    // in a non-browser environment) and re-emit its events on the room.
    this.quality = new RoomQualityController({
      room: this,
      ...(this.config.quality ?? {}),
      enabled: this.config.quality?.enabled ?? qualityEnvironmentSupported(),
      debug: this.debug,
    });
    this.quality.on('quality:changed', (event) => (this as any).emit('quality-changed', event));
    this.quality.on('quality:warning', (event) => (this as any).emit('local-quality-warning', event));
    this.processorChain = new ProcessorChain({ warn: (m, d) => this.debug(m, d) });
    const initialSfuGw = this.config.sfu?.gateway
      ?? this.config.sfuGateway
      ?? (this.config.topology?.sfu?.gateway as unknown as SfuGatewayLike | undefined);
    const useCustomMedia = this.config.mediaTransport ?? null;
    const buildMesh = (): MediaTransport => this.createMeshTransport();
    if (useCustomMedia) {
      this.media = useCustomMedia;
    } else if (
      (this.config.topology?.topology === 'sfu' || (this.config.topology?.sfu && this.config.topology?.topology !== 'mesh'))
      && initialSfuGw
    ) {
      const explicitSfu = this.config.topology?.topology === 'sfu';
      if (explicitSfu) {
        const sfuTransport = new SfuMediaTransport({
          roomId: this.roomId,
          selfId: this.config.selfId,
          sessionId: this.sessionId,
          gateway: initialSfuGw!,
          transport: this.transport,
          processorChain: this.processorChain,
          peerFactory: this.config.rtc?.peerFactory ?? this.config.peerFactory,
          getNextSeq: () => this.nextSeq(),
          debug: this.debug,
          emit: (event: string, ...args: unknown[]) => (this as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args),
          localPublications: () => [...this.local.publications],
          addRemoteTrack: (participantId, track, kind) => this.handleRemoteSfuTrack(participantId, track, kind),
        });
        void sfuTransport.init().catch((e) => this.debug('sfu:init-failed', e));
        this.media = sfuTransport;
      } else {
        this.media = buildMesh();
      }
    } else {
      this.media = buildMesh();
    }
    this.topologyController = new TopologyController({
      config: this.config.topology,
      getParticipantCount: () => this.remoteById.size,
      getTransport: () => this.media,
      switchTransport: async (kind) => this.switchMediaTransport(kind),
      debug: this.debug,
    });
    this.activeSpeaker = new ActiveSpeakerDetector({
      getPeerConnections: () => this.media.getPeerConnections(),
      participantIds: () => [...this.remoteById.keys()],
    });
    this.activeSpeaker.on('active-speaker', (ids) => this.emit('active-speaker', ids));
    this.egress = new EgressController();
    this.transcription = new TranscriptionController();
    this.transcription.onTranscript((e) => this.emit('transcript', { ...e, senderId: e.participantId }));
    this.media.onTrack((e) => {
      if (this.media.kind === 'sfu') {
        let p = this.remoteById.get(e.participantId);
        if (!p) {
          p = new RemoteParticipant({ id: e.participantId });
          this.remoteById.set(e.participantId, p);
          this.emit('participant-joined', p);
        }
      }
    });
    this.devices = new RoomDevicesFacade({
      mediaDevices: this.config.devices?.mediaDevices,
      getSenders: () => this.media.getSenders(),
      getLocalVideoTracks: () =>
        this.local.publications
          .filter((p) => p.kind === 'video' && p.track !== null)
          .map((p) => p.track as MediaStreamTrack),
      onTrackReplaced: (kind, oldTrack, newTrack) => {
        for (const publication of this.local.publications) {
          if (publication.kind === kind && publication.track === oldTrack) {
            publication.track = newTrack;
          }
        }
      },
      debug: this.debug,
    });
    // Re-emit device-change events on the room so apps can use room.on(...).
    this.devices.on('devices:changed', () => (this as any).emit('devices-changed'));
    // E2EE: construct processor when key is supplied; warn when unsupported.
    if (this.config.e2ee && typeof this.config.e2ee === 'object') {
      this.e2eeProcessor = new SFrameProcessor(this.config.e2ee.key);
      this.e2eeProcessor.on('e2ee:warning', (w) => {
        (this as any).emit('e2ee-warning', w);
        if (this.config.e2ee && typeof this.config.e2ee === 'object' && this.config.e2ee.required) {
          (this as any).emit('e2ee-error', new Error(w.message));
          this.emit('error', Object.assign(new Error(w.message), { code: 'e2ee-unsupported' }));
        }
      });
      this.e2eeProcessor.on('e2ee:error', (e) => {
        (this as any).emit('e2ee-error', e);
        this.emit('error', e);
      });
      this.e2eeProcessor.on('e2ee:key-rotated', () => (this as any).emit('e2ee-key-rotated'));
      if (!this.e2eeProcessor.supported && this.config.e2ee.required) {
        // Defer emit so listeners attached after construction can still hear it.
        queueMicrotask(() => {
          (this as any).emit('e2ee-warning', { code: 'e2ee-unsupported', message: 'E2EE required but not supported' });
          (this as any).emit('e2ee-error', new Error('E2EE required but not supported in this environment'));
        });
      }
      // Dev-only warning when auth is expected but not supplied (open mode in prod)
      // Mirrors plan: debug warns 'auth:missing-in-prod' when NODE_ENV===production and auth absent.
    }
    if (!this.config.auth?.token && typeof process !== 'undefined') {
      try {
        if ((process as unknown as { env?: Record<string, string> }).env?.NODE_ENV === 'production') {
          this.debug('auth:missing-in-prod', 'Room is in open mode while NODE_ENV=production');
        }
      } catch { /* ignore */ }
    }
    // Snapshot layer: rebuild + notify whenever tracked state mutates. Events
    // that do not affect the snapshot (reaction/chat/error/...) are
    // deliberately not wired — unrelated updates never notify subscribers.
    this.snapshotStore = new ObservableStore<RoomSnapshot>(this.buildSnapshot(), (error) => {
      this.debug('room:snapshot-listener-error', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
    const invalidate = () => this.invalidateSnapshot();
    for (const event of [
      'participant-joined',
      'participant-left',
      'participant-updated',
      'connection-state',
      'track',
      'track-unpublished',
      'quality-changed',
      'devices-changed',
    ] as const) {
      (this as any).on(event, invalidate);
    }
    // Topology auto: migrate mesh→sfu when count exceeds threshold.
    // maybeMigrate is no-op when topology!=='auto' or already sfu; stay-sfu
    // downgrade is manual via setTopology('mesh') for v1 (see topology.ts:maybeMigrate).
    const autoMigrate = () => { void this.topologyController.maybeMigrate().catch((e) => this.debug('topology:migrate-failed', e)); };
    (this as any).on('participant-joined', autoMigrate);
    (this as any).on('participant-left', autoMigrate);
  }

  // -------------------------------------------------------------- e2ee helpers

  get e2ee(): SFrameProcessor | null {
    return this.e2eeProcessor;
  }

  /** Rotate the E2EE key (re-sets transform on all senders/receivers). */
  async setE2eeKey(key: CryptoKey | Uint8Array): Promise<void> {
    if (!this.e2eeProcessor) {
      this.e2eeProcessor = new SFrameProcessor(key);
      this.e2eeProcessor.on('e2ee:key-rotated', () => (this as any).emit('e2ee-key-rotated'));
      this.e2eeProcessor.on('e2ee:warning', (w) => (this as any).emit('e2ee-warning', w));
      this.e2eeProcessor.on('e2ee:error', (e) => {
        (this as any).emit('e2ee-error', e);
        this.emit('error', e);
      });
      return;
    }
    await this.e2eeProcessor.setKey(key);
    for (const pc of this.media.getPeerConnections()) {
      try {
        await this.e2eeProcessor.setupPeerConnection(pc);
      } catch (err) {
        this.debug('e2ee:setup-failed', err);
      }
    }
  }

  // -------------------------------------------------------- processor / topology

  /** @deprecated Use `registerProcessor`. */
  useProcessor(processor: MediaProcessor): void {
    this.processorChain.add(processor);
  }

  /** Canonical processor registry (explicit over magic). */
  registerProcessor(processor: MediaProcessor): void {
    this.processorChain.add(processor);
  }

  /** @deprecated Use `registerProcessor` with dispose handling; kept for compat. */
  removeProcessor(processor: MediaProcessor): boolean {
    return this.processorChain.remove(processor);
  }

  unregisterProcessor(processor: MediaProcessor): boolean {
    return this.processorChain.remove(processor);
  }

  get topology(): Topology { return this.topologyController.topology; }
  get autoThreshold(): number { return this.topologyController.autoThreshold; }

  async setTopology(topology: Topology): Promise<void> {
    await this.topologyController.setTopology(topology);
  }

  /**
   * Prefer a simulcast/SVC layer for `trackId` (SFU only). Unified `VideoQuality`
   * enum mirrors `packages/sfu-gateway/src/sfu-gateway.ts:70` (`low|medium|high`
   * and aliases `l|m|h`) — mesh is a no-op (logs `sfu:layer-not-supported`).
   */
  async setPreferredLayers(trackId: string, layer: string): Promise<void> {
    if (this.media.setPreferredLayers) await this.media.setPreferredLayers(trackId, layer);
    else this.debug('sfu:layer-not-supported', trackId);
  }

  async requestKeyframe(trackId: string): Promise<void> {
    if (this.media.requestKeyframe) await this.media.requestKeyframe(trackId);
  }

  /**
   * Tile-aware layer/visibility helper. In SFU mode `layer` maps to
   * `setPreferredLayers`; in mesh `visible` toggles `track.enabled`.
   * ResizeObserver guidance: observe the tile element and call with the
   * rendered size so the SFU can downshift (`l` for hidden/small tiles):
   * ```ts
   * const ro = new ResizeObserver((entries) => {
   *   for (const e of entries) {
   *     const { width, height } = e.contentRect;
   *     const layer = width < 160 ? 'l' : width < 640 ? 'm' : 'h';
   *     void room.setTile(participantId, { width, height, layer, visible: true });
   *   }
   * });
   * ro.observe(tileEl);
   * ```
   */
  async setTile(_participantId: string, opts: { visible?: boolean; width?: number; height?: number; priority?: number; layer?: string }): Promise<void> {
    if (opts.layer && this.media.setPreferredLayers) {
      const p = this.remoteById.get(_participantId);
      const trackId = p?.publications[0]?.id;
      if (trackId) await this.media.setPreferredLayers(trackId, opts.layer);
    } else if (opts.visible === false) {
      const p = this.remoteById.get(_participantId);
      if (p) for (const pub of p.publications) if (pub.track) pub.track.enabled = false;
    } else if (opts.visible === true) {
      const p = this.remoteById.get(_participantId);
      if (p) for (const pub of p.publications) if (pub.track) pub.track.enabled = true;
    }
  }

  // -------------------------------------------------------- egress / transcription

  async startEgress(options: EgressOptions = {}): Promise<{ hlsUrl?: string; whepUrl?: string }> {
    const handle = this.egress.start(this.roomId, options);
    return { ...(handle.hlsUrl ? { hlsUrl: handle.hlsUrl } : {}), ...(handle.whepUrl ? { whepUrl: handle.whepUrl } : {}) };
  }

  async stopEgress(): Promise<void> {
    this.egress.stop(this.roomId);
  }

  async startTranscription(options: TranscriptionOptions = {}): Promise<void> {
    await this.transcription.start(options);
  }

  async stopTranscription(): Promise<void> {
    await this.transcription.stop();
  }

  async sendTranscript(text: string, opts: { isFinal?: boolean; lang?: string } = {}): Promise<void> {
    const payload: TranscriptPayload = { text, isFinal: opts.isFinal ?? true, ...(opts.lang ? { lang: opts.lang } : {}) };
    this.transcription.emitTranscript({ ...payload, participantId: this.local.id });
    // Fan-out via DataChannel where mesh, and via signaling as transcript envelope
    for (const bus of this.enumerateBuses()) {
      try { (bus as unknown as { sendTranscript?: (p: unknown) => void }).sendTranscript?.(payload); } catch { /* best effort */ }
    }
    await this.emitEnvelope('transcript', payload).catch(() => {});
  }

  // Moderation (client wrapper for POST /rooms/:id/moderate)
  async moderate(opts: { action: 'kick' | 'mute' | 'lock' | 'unlock' | 'ban' | 'unban'; participantId?: string; banTtlMs?: number }): Promise<void> {
    for (const bus of this.enumerateBuses()) {
      try { (bus as unknown as { sendControl: (m: unknown) => void }).sendControl?.({ action: `moderate:${opts.action}`, targetId: opts.participantId }); } catch { /* best effort */ }
    }
    await this.emitEnvelope('chat', { text: `/moderate ${opts.action} ${opts.participantId ?? ''}`.trim() } as unknown as ChatPayload).catch(()=>{});
  }

  // Poll (additive envelope via chat for now)
  async createPoll(question: string, options: string[]): Promise<void> {
    await this.emitEnvelope('chat', { text: JSON.stringify({ poll: { question, options } }) } as unknown as ChatPayload).catch(()=>{});
  }
  async votePoll(pollId: string, option: string): Promise<void> {
    await this.emitEnvelope('chat', { text: JSON.stringify({ vote: { pollId, option } }) } as unknown as ChatPayload).catch(()=>{});
  }
  async sendTyping(isTyping: boolean): Promise<void> {
    for (const bus of this.enumerateBuses()) {
      try { (bus as unknown as { sendControl: (m: unknown)=>void }).sendControl?.({ action: 'typing', isTyping, senderId: this.local.id }); } catch {}
    }
    await this.emitEnvelope('chat', { text: '' } as unknown as ChatPayload).catch(()=>{});
  }

  // Analytics: getCallStats sampler
  async getCallStats(): Promise<import('@mbsks/openrtc-quality').RTCStatsSnapshot> {
    const sampler = new (await import('./room-quality.ts')).RoomStatsSampler({ getPeerConnections: () => this.media.getPeerConnections() });
    return sampler.sample();
  }

  private createMeshTransport(): MeshMediaTransport {
    return new MeshMediaTransport({
      roomId: this.roomId,
      transport: this.transport,
      selfId: this.config.selfId,
      sessionId: this.sessionId,
      local: this.local,
      remotes: this.remoteById,
      orderBuffer: this.buffer,
      peerFactory: this.config.rtc?.peerFactory ?? this.config.peerFactory,
      iceServers: this.config.rtc?.iceServers ?? this.config.iceServers,
      polite: this.config.rtc?.polite ?? this.config.polite,
      autoRestartIce: this.config.rtc?.autoRestartIce ?? this.config.autoRestartIce,
      dataChannelName: this.config.rtc?.dataChannelName ?? this.config.dataChannelName,
      getNextSeq: () => this.nextSeq(),
      quality: this.quality,
      processorChain: this.processorChain,
      resolveIceServers: () => this.resolveIceServers(),
      e2eeSetupPeer: async (pc) => {
        if (this.e2eeProcessor?.supported) {
          try { await this.e2eeProcessor.setupPeerConnection(pc); } catch (e) { this.debug('e2ee:setup-failed', e); }
        }
      },
      debug: this.debug,
      emit: (event: string, ...args: unknown[]) => (this as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args),
    });
  }

  private async switchMediaTransport(kind: 'mesh' | 'sfu'): Promise<void> {
    const old = this.media;
    const from = old.kind;
    await old.close();
    if (kind === 'sfu') {
      const gw = (this.config.sfu?.gateway ?? this.config.sfuGateway ?? this.config.topology?.sfu?.gateway) as unknown as SfuGatewayLike | undefined;
      if (!gw) {
        this.debug('topology:sfu-no-gateway', 'no sfuGateway configured; staying mesh');
        this.media = this.createMeshTransport();
        return;
      }
      const sfu = new SfuMediaTransport({
        roomId: this.roomId, selfId: this.config.selfId, sessionId: this.sessionId,
        gateway: gw, transport: this.transport, processorChain: this.processorChain,
        peerFactory: this.config.rtc?.peerFactory ?? this.config.peerFactory, getNextSeq: () => this.nextSeq(), debug: this.debug,
        emit: (e: string, ...a: unknown[]) => (this as unknown as { emit: (ev: string, ...args: unknown[]) => void }).emit(e, ...a),
        localPublications: () => [...this.local.publications],
        addRemoteTrack: (pid, track, kind) => this.handleRemoteSfuTrack(pid, track, kind),
      });
      await sfu.init();
      this.media = sfu;
      this.media.onTrack(() => {});
      if (from !== kind) (this as any).emit('topology-changed', { from, to: kind });
    } else {
      this.media = this.createMeshTransport();
      if (from !== kind) (this as any).emit('topology-changed', { from, to: kind });
    }
  }

  private handleRemoteSfuTrack(participantId: string, track: MediaStreamTrack, kind: 'audio' | 'video'): void {
    let participant = this.remoteById.get(participantId);
    if (!participant) {
      participant = new RemoteParticipant({ id: participantId });
      this.remoteById.set(participantId, participant);
      this.emit('participant-joined', participant);
    }
    const id = (track as unknown as { id?: string }).id || (track as unknown as MediaStreamTrack).id || randomId();
    if (participant.getPublication(id)) return;
    const pub: TrackPublication = { id, kind, source: kind === 'video' ? 'camera' : 'microphone', participantId, isLocal: false, track: track as unknown as MediaStreamTrack, muted: false };
    participant.addPublication(pub);
    this.emit('track', { participant, publication: pub, track });
    (track as unknown as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.('ended', () => {
      const removed = participant!.removePublication(id);
      if (removed) this.emit('track-unpublished', { participant: participant!, publication: removed, track });
    });
  }

  /** Current auth token (if configured). */
  get authToken(): string | undefined {
    return this.config.auth?.token;
  }

  setAuthToken(token: string): void {
    if (!this.config.auth) this.config.auth = {};
    this.config.auth.token = token;
  }

  private effectiveIceServers(): RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>) | undefined {
    return this.config.rtc?.iceServers ?? this.config.iceServers;
  }

  /** Resolve TURN/ICE servers (cached). */
  async getIceServers(): Promise<RTCIceServer[]> {
    if (this.config.auth?.getTurnCredentials) {
      try {
        const servers = await this.config.auth.getTurnCredentials();
        this.pendingIceServers = servers;
        return servers;
      } catch (err) {
        this.debug('ice:turn-failed', err);
      }
    }
    const ice = this.effectiveIceServers();
    if (typeof ice === 'function') {
      const v = ice();
      return v instanceof Promise ? await v : v as RTCIceServer[];
    }
    if (Array.isArray(ice)) return ice;
    return this.pendingIceServers ?? [];
  }

  private async resolveIceServers(): Promise<RTCIceServer[]> {
    if (this.config.auth?.getTurnCredentials) {
      try {
        const servers = await this.config.auth.getTurnCredentials();
        this.pendingIceServers = servers;
        return servers;
      } catch (err) {
        this.debug('ice:turn-failed', err);
      }
    }
    const ice = this.effectiveIceServers();
    if (typeof ice === 'function') {
      const v = ice();
      const arr = v instanceof Promise ? await v : (v as RTCIceServer[]);
      if (arr.length) return arr;
    }
    if (Array.isArray(ice)) return ice;
    return this.pendingIceServers ?? [];
  }

  /** Handle an auth error from a transport layer (4401): refresh once and re-throw mapped error. */
  async handleAuthError(err: unknown): Promise<never> {
    const e = err instanceof Error ? err : new Error(String(err));
    (e as unknown as Record<string, unknown>).code = 'auth:error';
    (this as any).emit('auth-error', e);
    if (this.config.auth?.onTokenExpired && !this.authRefreshInFlight) {
      this.authRefreshInFlight = (async () => {
        try {
          const tok = await this.config.auth!.onTokenExpired!();
          if (tok) this.setAuthToken(tok);
          return tok;
        } catch {
          return null;
        } finally {
          this.authRefreshInFlight = null;
        }
      })();
    }
    if (this.authRefreshInFlight) {
      await this.authRefreshInFlight;
    }
    this.emit('error', e);
    throw e;
  }

  // -------------------------------------------------------------- join/leave

  /**
   * Join the room: subscribe to signaling + presence, announce ourselves.
   *
   * Concurrent `join()` calls are serialized: each waits for the previous
   * attempt to settle before running (a retried join after an aborted one
   * starts clean). Pass `options.signal` to cancel an in-flight join — see
   * `JoinOptions`.
   */
  async join(options: JoinOptions = {}): Promise<this> {
    const result = this.joinChain.then(
      () => this.runJoin(options.signal),
      () => this.runJoin(options.signal),
    );
    this.joinChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async runJoin(signal?: AbortSignal): Promise<this> {
    if (this.joined) return this;
    if (this.closed) throw new Error('Room is closed');
    const checkAborted = (): void => {
      if (signal?.aborted) throw signal.reason ?? new Error('Room.join aborted');
    };
    checkAborted();
    this.joining = true;
    this.invalidateSnapshot();
    const subscribedFrom = this.unsubscribers.length;
    let transportJoined = false;
    try {
      const info: ParticipantInfo = {
        id: this.local.id,
        displayName: this.local.displayName,
        metadata: this.local.metadata,
      };
      transportJoined = true;
      await this.transport.join(this.roomId, info);
      checkAborted();
      this.unsubscribers.push(
        this.transport.onMessage((envelope) => {
          this.handleEnvelope(envelope).catch((err) => this.reportError(err));
        }),
        this.transport.onPresence((presence) => this.handlePresence(presence)),
      );
      await this.transport.setPresence('online', this.local.metadata);
      checkAborted();
      await this.emitEnvelope('join', {
        displayName: this.local.displayName,
        metadata: this.local.metadata,
        deviceProfile: this.local.deviceProfile,
        capabilities: this.local.capabilities,
      });
      checkAborted();
    } catch (err) {
      // Roll back what this attempt did so a retry (or StrictMode remount)
      // starts from a clean slate.
      this.unsubscribers.splice(subscribedFrom);
      if (transportJoined && !this.closed) {
        try {
          await this.transport.leave();
        } catch {
          /* best effort */
        }
      }
      this.joining = false;
      this.invalidateSnapshot();
      throw err;
    }
    this.joined = true;
    this.joining = false;
    this.quality.start();
    this.activeSpeaker.start();
    this.invalidateSnapshot();
    return this;
  }

  /** Leave the room: announce, close all peer connections, unsubscribe. */
  async leave(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.joining = false;
    this.invalidateSnapshot();
    this.quality.stop();
    this.activeSpeaker.stop();
    try { await this.media.close(); } catch { /* ignore */ }
    // Stop any in-progress recording (uploads the finalize report).
    try {
      await this.recording.stopRecording();
    } catch (err) {
      this.debug('leave:recording-stop-failed', err);
    }
    // Release the devices facade's devicechange subscription.
    this.devices.dispose();
    try {
      await this.transport.setPresence('offline', undefined).catch(() => {});
      await this.emitEnvelope('leave', { reason });
    } catch (err) {
      this.debug('leave:announce-failed', err);
    }
    this.processorChain.dispose();
    for (const unsub of this.unsubscribers.splice(0)) unsub();
    try {
      await this.transport.leave();
    } catch (err) {
      this.debug('leave:transport-failed', err);
    }
    this.emit('closed');
  }

  /** Alias of `leave()`. */
  async close(): Promise<void> {
    await this.leave();
  }

  // -------------------------------------------------------------- publishing

  /** Publish a local track (delegates to MediaTransport). Merges `publishDefaults` when options are absent. */
  async publish(track: MediaStreamTrack, options: PublishOptions = {}): Promise<TrackPublication> {
    if (this.closed) throw new Error('Room is closed');
    const defaults = this.config.publishDefaults ?? {};
    const merged: PublishOptions = {
      simulcast: options.simulcast ?? defaults.simulcast,
      svc: options.svc ?? defaults.svc,
      codecPreferences: options.codecPreferences ?? defaults.codecPreferences,
      source: options.source ?? defaults['source' as keyof typeof defaults] as unknown as TrackPublication['source'],
      metadata: options.metadata,
    };
    // Remove undefined keys so transport sees only explicit values.
    const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as PublishOptions;
    const pub = await this.media.publish(track, clean as unknown as ExtendedPublishOptions);
    if (!this.local.getPublication(pub.id)) {
      this.local.addPublication(pub);
      this.invalidateSnapshot();
    } else {
      this.invalidateSnapshot();
    }
    await this.quality.attachTrack((pub.track ?? track) as unknown as MediaStreamTrack);
    return this.local.getPublication(pub.id) ?? pub;
  }

  /** Stop publishing a local track and renegotiate. */
  async unpublish(publication: TrackPublication): Promise<void> {
    const stored = this.local.getPublication(publication.id);
    const track = (stored?.track ?? publication.track) as unknown as MediaStreamTrack | null;
    const pubForMedia: TrackPublication = { ...publication, track } as TrackPublication;
    if (stored) {
      this.local.removePublication(publication.id);
      this.invalidateSnapshot();
    } else {
      const r = this.local.removePublication(publication.id);
      if (r) this.invalidateSnapshot();
    }
    if (track) this.quality.detachTrack(track as unknown as MediaStreamTrack);
    await this.media.unpublish(pubForMedia);
  }

  /**
   * Subscribe to a remote participant's media. In mesh mode tracks arrive
   * automatically via `ontrack`; the subscription is a control handle (e.g.
   * to pause decoding of a hidden tile). Single-object options, no overloads (explicit over magic).
   */
  subscribe(participantId: string, options?: MediaSubscribeOptions): Promise<TrackSubscription>;
  /**
   * @deprecated Use `room.store.subscribe(listener)` or `room.onSnapshot(listener)` — kept for backward compat.
   */
  subscribe(listener: () => void): () => void;
  subscribe(
    participantIdOrListener: string | (() => void),
    options?: MediaSubscribeOptions,
  ): Promise<TrackSubscription> | (() => void) {
    // Backward-compat: if a function is passed, treat as snapshot subscription (deprecated).
    if (typeof participantIdOrListener === 'function') {
      return this.snapshotStore.subscribe(participantIdOrListener);
    }
    const participant = this.remoteById.get(participantIdOrListener);
    const kind = options?.kind;
    if (!participant) {
      throw new Error(`Room: unknown participant '${participantIdOrListener}'`);
    }
    const matching = () => participant.publications.filter((p) => !kind || p.kind === kind);
    return Promise.resolve({
      participantId: participantIdOrListener,
      get publication(): TrackPublication | undefined {
        return matching()[0];
      },
      setEnabled(enabled: boolean): void {
        for (const p of matching()) if (p.track) p.track.enabled = enabled;
      },
      close(): void {
        /* mesh: no decoder resources to release */
      },
    });
  }

  // -------------------------------------------------------------- presence

  async setPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    if (metadata !== undefined) {
      this.local.setMetadata(metadata);
      this.invalidateSnapshot();
    }
    await this.transport.setPresence(state, metadata ?? this.local.metadata);
    await this.emitEnvelope('presence', { state, metadata });
  }

  // -------------------------------------------------------- reactions / chat

  /** Broadcast a reaction to the room (backend pub/sub path). */
  async sendReaction(emoji: string, targetSenderId?: string): Promise<void> {
    await this.emitEnvelope('reaction', { emoji, targetSenderId, ts: Date.now() });
  }

  /** Broadcast a chat message to the room (backend pub/sub path). */
  async sendChat(text: string, replyTo?: ChatPayload['replyTo']): Promise<void> {
    await this.emitEnvelope('chat', { text, replyTo });
  }

  /** Announce a screen-share start/stop (the track itself is `publish()`ed). */
  async announceScreenShare(action: 'start' | 'stop', label?: string): Promise<void> {
    await this.emitEnvelope('screen-share', { action, label });
  }

  private enumerateBuses(): unknown[] {
    const out: unknown[] = [];
    if (this.media.kind === 'mesh') {
      const mesh = this.media as unknown as { getDataChannelBus?: (id: string) => unknown };
      for (const id of this.remoteById.keys()) {
        const bus = mesh.getDataChannelBus?.(id);
        if (bus) out.push(bus);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- ICE control

  /** Restart ICE for one peer (default: all peers). */
  async restartIce(participantId?: string): Promise<void> {
    if (this.media.restartIce) await this.media.restartIce(participantId);
  }

  // -------------------------------------------------------------- accessors

  getParticipants(): RemoteParticipant[] {
    return [...this.remoteById.values()];
  }

  getParticipant(id: string): RemoteParticipant | undefined {
    return this.remoteById.get(id);
  }

  getPeerConnection(participantId: string): RTCPeerConnection | undefined {
    const withLookup = this.media as unknown as { getPeerConnection?: (id: string) => RTCPeerConnection | undefined };
    if (typeof withLookup.getPeerConnection === 'function') {
      const pc = withLookup.getPeerConnection(participantId);
      if (pc) return pc;
    }
    // Fallback for transports without per-id lookup: try DataChannelBus map (mesh).
    const bus = (this.media as unknown as { getDataChannelBus?: (id: string) => unknown }).getDataChannelBus?.(participantId);
    if (bus) {
      // Mesh keeps 1:1 PC per participant; find it via getPeerConnections if not directly exposed.
      // We already tried per-id; return first only as last resort when participant exists but lookup failed.
      const all = this.media.getPeerConnections();
      // Best-effort: if only one PC, return it; otherwise undefined to avoid returning wrong peer.
      if (all.length === 1) return all[0];
    }
    return undefined;
  }

  /** All live peer connections (the adaptive-quality sampler polls their stats). */
  getPeerConnections(): RTCPeerConnection[] {
    return this.media.getPeerConnections();
  }

  /** All local senders across live peer connections (adaptive-quality reach). */
  getSenders(): RTCRtpSender[] {
    return this.media.getSenders();
  }

  /** The typed data channel for a peer (reactions/chat/control over SCTP). */
  getDataChannelBus(participantId: string): unknown {
    return (this.media.getDataChannelBus as unknown as ((id: string) => unknown) | undefined)?.(participantId);
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ------------------------------------------------------- snapshot / store

  /** Canonical snapshot store. `room.store.subscribe(listener)` / `room.onSnapshot(listener)` preferred over `room.subscribe(listener)` (deprecated). */
  get store(): ObservableStore<RoomSnapshot> {
    return this.snapshotStore;
  }

  /** Subscribe to snapshot changes (canonical). Alias for `room.store.subscribe`. */
  onSnapshot(listener: () => void): () => void {
    return this.snapshotStore.subscribe(listener);
  }

  /**
   * The current immutable room state. Returns the same object reference until
   * tracked state (roster, presence/connection per participant, local
   * publications, join lifecycle, quality tier) actually changes — safe as a
   * `useSyncExternalStore` snapshot.
   */
  getSnapshot(): RoomSnapshot {
    if (this.snapshotDirty) this.refreshSnapshot();
    return this.snapshotStore.getSnapshot();
  }

  // ------------------------------------------------------------- internals

  private get debug(): (message: string, data?: unknown) => void {
    return this.config.debug ?? (() => {});
  }

  /** Current lifecycle status for the snapshot. */
  private snapshotStatus(): RoomSnapshot['status'] {
    if (this.closed) return 'closed';
    if (this.joined) return 'joined';
    return this.joining ? 'joining' : 'new';
  }

  private buildSnapshot(): RoomSnapshot {
    return buildRoomSnapshot({
      roomId: this.roomId,
      selfId: this.local.id,
      status: this.snapshotStatus(),
      qualityTierId: this.quality.currentTierId,
      local: this.local,
      remotes: [...this.remoteById.values()],
    });
  }

  /**
   * Called after every tracked mutation. With subscribers attached the next
   * snapshot is built immediately and pushed (unless it is structurally equal
   * to the current one — duplicate events never cause redundant notifies);
   * otherwise we only mark dirty for a lazy rebuild on `getSnapshot()`.
   */
  private invalidateSnapshot(): void {
    if (this.snapshotStore.listenerCount === 0) {
      this.snapshotDirty = true;
      return;
    }
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    this.snapshotDirty = false;
    const previous = this.snapshotStore.getSnapshot();
    const next = this.buildSnapshot();
    // Keep the old reference when nothing actually changed so UI bindings
    // stay referentially stable.
    this.snapshotStore.set(roomSnapshotsEqual(previous, next) ? previous : next);
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private async emitEnvelope<K extends Envelope['type']>(
    type: K,
    payload: Extract<Envelope, { type: K }>['payload'],
    targetSenderId?: string,
  ): Promise<void> {
    const envelope = {
      v: 1 as const,
      type,
      roomId: this.roomId,
      senderId: this.local.id,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      ...(targetSenderId !== undefined ? { targetSenderId } : {}),
      payload,
    } as Envelope;
    await this.transport.emit(envelope);
  }

  private async emitSignalTo(participantId: string, signal: { type: string; payload: unknown }): Promise<void> {
    const base = {
      roomId: this.roomId,
      senderId: this.local.id,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      targetSenderId: participantId,
    };
    const envelope: Envelope =
      signal.type === 'ice'
        ? { v: 1, type: 'ice', ...base, payload: signal.payload as unknown as IcePayload }
        : { v: 1, type: signal.type as 'offer' | 'answer', ...base, payload: signal.payload as unknown as OfferPayload };
    await this.transport.emit(envelope);
  }

  private async handleEnvelope(envelope: Envelope): Promise<void> {
    // Ignore our own echoes and messages addressed to someone else.
    if (envelope.senderId === this.local.id) return;
    if (envelope.targetSenderId && envelope.targetSenderId !== this.local.id) return;
    // Ordering/idempotency: drop stale/duplicate envelopes per sender session.
    if (!this.buffer.accept(envelope)) return;

    switch (envelope.type) {
      case 'join':
        await this.handleRemoteJoin(envelope.senderId, envelope.payload);
        break;
      case 'leave':
        this.handleRemoteLeave(envelope.senderId);
        break;
      case 'presence':
        if (envelope.payload?.state !== undefined) {
          const participant = this.remoteById.get(envelope.senderId);
          if (participant) {
            participant.presence = envelope.payload.state;
            this.emit('participant-updated', participant);
            this.emit('presence', {
              id: participant.id,
              displayName: participant.displayName,
              metadata: envelope.payload.metadata,
              state: envelope.payload.state,
            });
          }
        }
        break;
      case 'offer':
      case 'answer':
      case 'ice': {
        const handled = await this.media.handleEnvelope?.(envelope);
        if (handled) break;
        if (envelope.type === 'offer' || envelope.type === 'answer') {
          if (!envelope.payload || typeof (envelope.payload as { sdp?: string }).sdp !== 'string') {
            this.debug('signal:missing-sdp', envelope.type);
            return;
          }
        } else if (envelope.type === 'ice') {
          if (!envelope.payload || typeof (envelope.payload as { candidate?: string }).candidate !== 'string') return;
        }
        if (this.media.kind === 'mesh') {
          await (this.media as unknown as { handleEnvelope: (e: Envelope) => Promise<boolean> }).handleEnvelope(envelope);
        }
        break;
      }
      case 'reaction':
        this.emit('reaction', {
          ...(envelope.payload ?? { emoji: '' }),
          senderId: envelope.senderId,
          participantId: envelope.senderId,
        });
        break;
      case 'chat':
        this.emit('chat', {
          ...(envelope.payload ?? { text: '' }),
          senderId: envelope.senderId,
          participantId: envelope.senderId,
        });
        break;
      case 'screen-share':
        if (envelope.payload?.action) {
          this.emit('screen-share', {
            ...envelope.payload,
            senderId: envelope.senderId,
            participantId: envelope.senderId,
          });
        }
        break;
      case 'quality-warning':
        if (envelope.payload?.from && envelope.payload?.to) {
          this.emit('quality-warning', {
            ...envelope.payload,
            senderId: envelope.senderId,
            participantId: envelope.senderId,
          });
        }
        break;
      case 'transcript':
        if (envelope.payload?.text !== undefined) {
          const tp = envelope.payload as TranscriptPayload;
          this.transcription.emitTranscript({ ...tp, participantId: envelope.senderId });
          this.emit('transcript', { ...tp, senderId: envelope.senderId, participantId: envelope.senderId });
        }
        break;
      case 'ping':
        await this.emitEnvelope('pong', {});
        break;
      case 'pong':
        break;
      case 'sfu': {
        const handled = await this.media.handleSfuEnvelope?.(envelope);
        if (!handled) this.debug('sfu:unhandled', envelope);
        break;
      }
      case 'error': {
        const code = (envelope.payload as { code?: string })?.code;
        const msg = (envelope.payload as { message?: string })?.message ?? 'remote error';
        const err = new Error(msg);
        if (code === 'unauthorized' || code === 'token_expired' || code === 'forbidden') {
          (err as unknown as Record<string, unknown>).code = code;
          (this as any).emit('auth-error', err);
          if (this.config.auth?.onTokenExpired) {
            void this.handleAuthError(err).catch(() => {});
          }
        }
        this.reportError(err);
        break;
      }
    }
  }

  private async handleRemoteJoin(senderId: string, payload?: JoinPayload): Promise<void> {
    const existing = this.remoteById.get(senderId);
    if (existing) {
      existing.update({
        displayName: payload?.displayName,
        metadata: payload?.metadata,
        deviceProfile: payload?.deviceProfile,
        capabilities: payload?.capabilities,
      });
      this.emit('participant-updated', existing);
      return;
    }
    const participant = new RemoteParticipant({
      id: senderId,
      displayName: payload?.displayName,
      metadata: payload?.metadata,
      deviceProfile: payload?.deviceProfile,
      capabilities: payload?.capabilities,
    });
    this.remoteById.set(senderId, participant);
    this.emit('participant-joined', participant);
    // auto-migrate wired via constructor listener on 'participant-joined' (see topology.ts)
    // Roster reply: announce ourselves back to the newcomer (targeted, so it
    // never echoes again) — the mesh equivalent of a join acknowledgment.
    await this.emitEnvelope(
      'join',
      {
        displayName: this.local.displayName,
        metadata: this.local.metadata,
        deviceProfile: this.local.deviceProfile,
        capabilities: this.local.capabilities,
      },
      senderId,
    );
    // If we already have local tracks, open a peer connection and offer (mesh only).
    if (this.local.publications.length > 0 && this.media.kind === 'mesh') {
      const mesh = this.media as unknown as { ensurePeer: (id: string) => Promise<{ manager: { negotiate: (r: string) => Promise<void> } }> };
      if (typeof mesh.ensurePeer === 'function') {
        const entry = await mesh.ensurePeer(senderId);
        await entry.manager.negotiate('remote-joined');
      }
    }
  }

  private handleRemoteLeave(senderId: string): void {
    const participant = this.remoteById.get(senderId);
    if (this.media.kind === 'mesh') {
      const mesh = this.media as unknown as { handleRemoteLeave: (id: string) => void };
      mesh.handleRemoteLeave?.(senderId);
    }
    if (participant) {
      this.remoteById.delete(senderId);
      this.emit('participant-left', participant);
    }
    // auto-migrate wired via constructor listener on 'participant-left'
  }

  private handlePresence(presence: {
    participantId: string;
    state: PresenceState;
    metadata?: Record<string, unknown>;
  }): void {
    if (presence.participantId === this.local.id) return;
    const participant = this.remoteById.get(presence.participantId);
    if (participant) {
      participant.presence = presence.state;
      this.emit('participant-updated', participant);
    }
    this.emit('presence', {
      id: presence.participantId,
      state: presence.state,
      metadata: presence.metadata,
    });
  }


  private normalizeConfig(config: RoomConfig): RoomConfig {
    const merged: RoomConfig = { ...config };
    // rtc grouping: flat aliases fill missing rtc fields and vice versa
    const rtc: RoomRtcOptions = { ...(config.rtc ?? {}) };
    if (config.peerFactory && !rtc.peerFactory) rtc.peerFactory = config.peerFactory;
    if (config.iceServers !== undefined && rtc.iceServers === undefined) rtc.iceServers = config.iceServers;
    if (config.polite !== undefined && rtc.polite === undefined) rtc.polite = config.polite;
    if (config.autoRestartIce !== undefined && rtc.autoRestartIce === undefined) rtc.autoRestartIce = config.autoRestartIce;
    if (config.dataChannelName !== undefined && rtc.dataChannelName === undefined) rtc.dataChannelName = config.dataChannelName;
    if (Object.keys(rtc).length) {
      merged.rtc = rtc;
      // backfill flat for internal consumers that still read flat
      if (rtc.peerFactory) merged.peerFactory = rtc.peerFactory;
      if (rtc.iceServers !== undefined) merged.iceServers = rtc.iceServers;
      if (rtc.polite !== undefined) merged.polite = rtc.polite;
      if (rtc.autoRestartIce !== undefined) merged.autoRestartIce = rtc.autoRestartIce;
      if (rtc.dataChannelName !== undefined) merged.dataChannelName = rtc.dataChannelName;
    }
    // sfu canonical consolidation: sfu.gateway is canonical; keep sfuGateway and topology.sfu.gateway as aliases
    const gw = config.sfu?.gateway ?? config.sfuGateway ?? (config.topology?.sfu?.gateway as unknown as SfuGatewayLike | undefined);
    if (gw) {
      merged.sfu = { gateway: gw };
      // keep aliases for compat (deprecated)
      if (!merged.sfuGateway) (merged as unknown as Record<string, unknown>).sfuGateway = gw;
    }
    // recording consolidation: recording.endpoint canonical; recordingEndpoint deprecated alias
    if (config.recordingEndpoint && !config.recording?.endpoint) {
      merged.recording = { ...(config.recording ?? {}), endpoint: config.recordingEndpoint };
    }
    // also keep recordingEndpoint alias if only recording.endpoint is set (for compat reading)
    if (config.recording?.endpoint && !merged.recordingEndpoint) {
      (merged as unknown as Record<string, unknown>).recordingEndpoint = config.recording.endpoint;
    }
    return merged;
  }

  private reportError(err: Error): void {
    this.debug('room:error', err);
    this.emit('error', err);
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
