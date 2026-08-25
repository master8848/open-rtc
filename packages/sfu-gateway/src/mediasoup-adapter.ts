/**
 * MediasoupAdapter — reference `SfuGateway` implementation on mediasoup.
 *
 * Maps the transport-agnostic gateway contract onto a mediasoup `Router`
 * (which the app creates from a `Worker`; see the env-gated integration test
 * `test/integration.mediasoup.test.ts` for the full wiring):
 *
 * | SfuGateway/SfuSession | mediasoup                                        |
 * | --------------------- | ------------------------------------------------ |
 * | `join`                | `router.createWebRtcTransport()`                 |
 * | `publishTrack`        | `transport.produce()` (once the offer arrives)   |
 * | `subscribe`           | `transport.consume()`                            |
 * | `setPreferredLayers`  | `consumer.setPreferredLayers()`                  |
 * | `requestKeyframe`     | `consumer.requestKeyFrame()` (receiver-driven)   |
 * | `handleOffer`         | `transport.connect({ dtlsParameters })` + produce|
 * | `handleAnswer`        | `transport.connect({ dtlsParameters })`          |
 * | `addIceCandidate`     | no-op (mediasoup >= 3.23 needs no remote ICE)    |
 * | `leave`               | `transport.close()`                              |
 *
 * The adapter only `import type`s mediasoup: at runtime it touches the
 * `Router` instance you pass in, so unit/smoke tests run with a fake router
 * and no mediasoup worker.
 *
 * Reference quality: SDP translation is deliberately minimal (see `sdp.ts`);
 * swap in a full SDP library for production codec negotiation. `mediasoup` is
 * a pinned devDependency (3.23.1, published 2026-07-28, >= 14-day age gate;
 * latest 3.24.x was < 14 days old at scaffold time).
 */
import type { SfuKind } from '@mbsks/openrtc-protocol';
import type { types as MediasoupTypes } from 'mediasoup';
import type {
  PublishOptions,
  SfuGateway,
  SfuJoinOptions,
  SfuSession,
  SfuTrackEvent,
  SfuTransportOptions,
  SubscribeOptions,
} from './sfu-gateway.ts';
import { sessionKey } from './sfu-gateway.ts';
import {
  buildSdpAnswer,
  dtlsParametersFromSdp,
  minimalRtpParameters,
  type SdpCandidate,
} from './sdp.ts';

/** Constructor options for {@link MediasoupAdapter}. */
export interface MediasoupAdapterOptions {
  /** The mediasoup `Router` this adapter serves (one per room in practice). */
  router: MediasoupTypes.Router;
  /**
   * Default `WebRtcTransportOptions` merged under (and overridden by) per-join
   * `transportOpts`. Set `listenIps` (or `listenInfos`) here in production.
   */
  defaultTransportOptions?: Partial<MediasoupTypes.WebRtcTransportOptions>;
  /**
   * Called with the adapter's SDP answer for a participant. The app sends it
   * back over signaling as an `answer` envelope addressed to that participant.
   */
  onAnswer?: (roomId: string, participantId: string, sdp: string) => void;
}

interface ProducerRecord {
  producer: MediasoupTypes.Producer;
  participantId: string;
}

/**
 * Reference adapter: `SfuGateway` over a mediasoup `Router`.
 *
 * Construct one per room (`new MediasoupAdapter({ router })`) — mediasoup RTP
 * capabilities are per-`Router`, and `Room` will own one gateway per room.
 */
export class MediasoupAdapter implements SfuGateway {
  readonly router: MediasoupTypes.Router;
  private readonly defaultTransportOptions: Partial<MediasoupTypes.WebRtcTransportOptions>;
  private readonly onAnswer?: (roomId: string, participantId: string, sdp: string) => void;
  private readonly sessions = new Map<string, MediasoupSession>();
  private readonly producersByRoom = new Map<string, Map<string, ProducerRecord>>();
  private readonly trackListeners = new Set<(event: SfuTrackEvent) => void>();

  constructor(options: MediasoupAdapterOptions) {
    this.router = options.router;
    this.defaultTransportOptions = options.defaultTransportOptions ?? {};
    this.onAnswer = options.onAnswer;
  }

  // ------------------------------------------------------------- SfuGateway

  async join(roomId: string, participantId: string, opts?: SfuJoinOptions): Promise<SfuSession> {
    const key = sessionKey(roomId, participantId);
    if (this.sessions.has(key)) {
      throw new Error(`participant ${participantId} already joined room ${roomId}`);
    }
    // The generic contract is intentionally open; the adapter owns producing a
    // valid mediasoup option object (listenIps/listenInfos/webRtcServer).
    const transport = await this.router.createWebRtcTransport({
      ...this.defaultTransportOptions,
      ...this.toTransportOptions(opts?.transportOpts),
      appData: { roomId, participantId },
    } as MediasoupTypes.WebRtcTransportOptions);
    const session = new MediasoupSession(this, roomId, participantId, transport);
    this.sessions.set(key, session);
    return session;
  }

  onTrack(cb: (event: SfuTrackEvent) => void): () => void {
    this.trackListeners.add(cb);
    return () => {
      this.trackListeners.delete(cb);
    };
  }

  async close(roomId?: string): Promise<void> {
    const targets = [...this.sessions.values()].filter(
      (s) => roomId === undefined || s.roomId === roomId,
    );
    for (const session of targets) {
      await session.leave();
    }
  }

  // ------------------------------------------------- @internal (for session)

  /** @internal Adapter-facing hooks used by MediasoupSession. */
  registerProducer(
    roomId: string,
    trackId: string,
    producer: MediasoupTypes.Producer,
    participantId: string,
  ): void {
    let roomTracks = this.producersByRoom.get(roomId);
    if (!roomTracks) {
      roomTracks = new Map();
      this.producersByRoom.set(roomId, roomTracks);
    }
    roomTracks.set(trackId, { producer, participantId });
  }

  /** @internal */
  producersOf(roomId: string, participantId: string): Map<string, MediasoupTypes.Producer> {
    const out = new Map<string, MediasoupTypes.Producer>();
    for (const [trackId, rec] of this.producersByRoom.get(roomId) ?? []) {
      if (rec.participantId === participantId) out.set(trackId, rec.producer);
    }
    return out;
  }

  /** @internal */
  unregisterSession(roomId: string, participantId: string): boolean {
    const key = sessionKey(roomId, participantId);
    const removed = this.sessions.delete(key);
    const roomTracks = this.producersByRoom.get(roomId);
    if (roomTracks) {
      for (const [trackId, rec] of roomTracks) {
        if (rec.participantId === participantId) roomTracks.delete(trackId);
      }
    }
    return removed;
  }

  /** @internal */
  emitTrackEvent(event: SfuTrackEvent): void {
    for (const listener of [...this.trackListeners]) listener(event);
  }

  /** @internal */
  notifyAnswer(roomId: string, participantId: string, sdp: string): void {
    this.onAnswer?.(roomId, participantId, sdp);
  }

  async createWhipTransport(roomId: string): Promise<{ transport: import('mediasoup').types.PlainTransport }> {
    const transport = await this.router.createPlainTransport({
      listenIp: '127.0.0.1',
      rtcpMux: true,
      comedia: true,
      appData: { roomId, kind: 'whip' },
    } as unknown as import('mediasoup').types.PlainTransportOptions);
    return { transport };
  }

  async createWhepTransport(roomId: string): Promise<{ transport: import('mediasoup').types.PlainTransport }> {
    const transport = await this.router.createPlainTransport({
      listenIp: '127.0.0.1',
      rtcpMux: true,
      comedia: false,
      appData: { roomId, kind: 'whep' },
    } as unknown as import('mediasoup').types.PlainTransportOptions);
    return { transport };
  }

  async startEgress(roomId: string, opts: { hls?: boolean; rtmpUrl?: string }): Promise<{ hlsUrl?: string; whepUrl?: string }> {
    void roomId; void opts;
    const hlsUrl = opts.hls ? `/hls/${encodeURIComponent(roomId)}/index.m3u8` : undefined;
    return { ...(hlsUrl ? { hlsUrl } : {}) };
  }

  async stopEgress(roomId: string): Promise<void> { void roomId; }

  // ------------------------------------------------------------------ utils

  /** Map the generic transport options onto mediasoup `WebRtcTransportOptions`. */
  private toTransportOptions(
    transportOpts?: SfuTransportOptions,
  ): Partial<MediasoupTypes.WebRtcTransportOptions> {
    const out: Partial<MediasoupTypes.WebRtcTransportOptions> = {};
    if (!transportOpts) return out;
    if (transportOpts.ice !== undefined) {
      out.enableUdp = transportOpts.ice;
      out.enableTcp = transportOpts.ice;
    }
    if (transportOpts.sctp !== undefined) {
      out.enableSctp = transportOpts.sctp;
    }
    // Forward adapter-specific keys (e.g. listenIps) verbatim — the generic
    // contract keeps them open so adapters can grow without protocol changes.
    for (const [key, value] of Object.entries(transportOpts)) {
      if (key === 'ice' || key === 'dtls' || key === 'sctp') continue;
      (out as Record<string, unknown>)[key] = value;
    }
    return out;
  }
}

/**
 * One participant's mediasoup session: a `WebRtcTransport` plus the
 * producers (send side) and consumers (receive side) attached to it.
 */
class MediasoupSession implements SfuSession {
  readonly roomId: string;
  readonly participantId: string;
  private readonly adapter: MediasoupAdapter;
  private readonly transport: MediasoupTypes.WebRtcTransport;
  private readonly pendingPublishes = new Map<string, { kind: SfuKind; opts?: PublishOptions }>();
  private readonly producers = new Map<string, MediasoupTypes.Producer>();
  private readonly consumers = new Map<string, MediasoupTypes.Consumer>();
  /** Remote ICE candidates kept for diagnostics (mediasoup >= 3.23 consumes none). */
  private readonly remoteCandidates: Array<{
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  }> = [];
  private connected = false;

  constructor(
    adapter: MediasoupAdapter,
    roomId: string,
    participantId: string,
    transport: MediasoupTypes.WebRtcTransport,
  ) {
    this.adapter = adapter;
    this.roomId = roomId;
    this.participantId = participantId;
    this.transport = transport;
  }

  async publishTrack(trackId: string, kind: SfuKind, opts?: PublishOptions): Promise<void> {
    if (this.producers.has(trackId)) {
      throw new Error(`track ${trackId} already published`);
    }
    this.pendingPublishes.set(trackId, { kind, opts });
  }

  async subscribe(participantId: string, _opts?: SubscribeOptions): Promise<void> {
    const producers = this.adapter.producersOf(this.roomId, participantId);
    if (producers.size === 0) return; // nothing published yet; see README
    for (const [trackId, producer] of producers) {
      if (this.consumers.has(trackId)) continue;
      const consumer = await this.transport.consume({
        producerId: producer.id,
        rtpCapabilities: this.adapter.router.rtpCapabilities,
        appData: { trackId, roomId: this.roomId, participantId: this.participantId },
      });
      this.consumers.set(trackId, consumer);
      this.adapter.emitTrackEvent({
        roomId: this.roomId,
        participantId: this.participantId,
        trackId,
        kind: consumer.kind === 'audio' ? 'audio' : 'video',
        direction: 'receive',
        publicationId: consumer.id,
      });
    }
  }

  async setPreferredLayers(trackId: string, layer: string): Promise<void> {
    const consumer = this.consumers.get(trackId);
    if (!consumer) throw new Error(`no consumer for track ${trackId}`);
    const spatialLayer = layer === 'l' ? 0 : layer === 'm' ? 1 : layer === 'h' ? 2 : -1;
    await consumer.setPreferredLayers({ spatialLayer, temporalLayer: -1 });
  }

  /** Keyframe requests are receiver-driven in mediasoup: `consumer.requestKeyFrame()`. */
  async requestKeyframe(trackId: string): Promise<void> {
    const consumer = this.consumers.get(trackId);
    if (!consumer) throw new Error(`no consumer for track ${trackId} (subscribe first)`);
    await consumer.requestKeyFrame();
  }

  async handleOffer(offer: { sdp: string }): Promise<void> {
    const dtls = dtlsParametersFromSdp(offer.sdp);
    if (!dtls) throw new Error('offer SDP has no DTLS fingerprint');
    if (!this.connected) {
      await this.transport.connect({ dtlsParameters: dtls });
      this.connected = true;
    }
    // Produce every pending publication whose m-line is present in this offer.
    for (const [trackId, pending] of [...this.pendingPublishes]) {
      const rtpParameters = minimalRtpParameters(offer.sdp, pending.kind);
      if (!rtpParameters) continue; // m-line for this kind not in this offer yet
      const producer = await this.transport.produce({
        kind: pending.kind === 'audio' ? 'audio' : 'video',
        rtpParameters,
        // mediasoup 3.23 `ProducerOptions.keyFrameRequestDelay` (ms before the
        // worker asks the sender for a new key frame after a previous request;
        // video-only hint, default 0).
        ...(pending.kind !== 'audio' && pending.opts?.keyFrameRequestDelayMs !== undefined
          ? { keyFrameRequestDelay: pending.opts.keyFrameRequestDelayMs }
          : {}),
        appData: { trackId, roomId: this.roomId, participantId: this.participantId },
      });
      this.producers.set(trackId, producer);
      this.pendingPublishes.delete(trackId);
      this.adapter.registerProducer(this.roomId, trackId, producer, this.participantId);
      this.adapter.emitTrackEvent({
        roomId: this.roomId,
        participantId: this.participantId,
        trackId,
        kind: pending.kind,
        direction: 'send',
        publicationId: producer.id,
      });
    }
    this.adapter.notifyAnswer(this.roomId, this.participantId, this.buildAnswerSdp());
  }

  async handleAnswer(answer: { sdp: string }): Promise<void> {
    const dtls = dtlsParametersFromSdp(answer.sdp);
    if (!dtls) throw new Error('answer SDP has no DTLS fingerprint');
    if (!this.connected) {
      await this.transport.connect({ dtlsParameters: dtls });
      this.connected = true;
    }
  }

  /**
   * mediasoup >= 3.23 WebRtcTransports do not consume remote ICE candidates
   * (ICE consent is handled by the worker via `iceConsentTimeout`); candidates
   * are kept for diagnostics so the interface contract holds for other SFUs.
   */
  async addIceCandidate(candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  }): Promise<void> {
    this.remoteCandidates.push(candidate);
  }

  async leave(): Promise<void> {
    if (this.transport.closed) return;
    this.transport.close();
    this.pendingPublishes.clear();
    this.producers.clear();
    this.consumers.clear();
    this.adapter.unregisterSession(this.roomId, this.participantId);
  }

  /** Minimal answer SDP from the transport's local ICE/DTLS parameters. */
  private buildAnswerSdp(): string {
    const candidates: SdpCandidate[] = this.transport.iceCandidates.map((c) => ({
      foundation: c.foundation,
      priority: c.priority,
      protocol: c.protocol,
      address: c.address,
      port: c.port,
      type: c.type,
      ...(c.tcpType !== undefined ? { tcpType: c.tcpType } : {}),
    }));
    return buildSdpAnswer({
      iceUfrag: this.transport.iceParameters.usernameFragment,
      icePwd: this.transport.iceParameters.password,
      fingerprints: this.transport.dtlsParameters.fingerprints,
      setup: 'passive',
      candidates,
      media: [...this.producers.entries()].map(([_trackId, producer], i) => ({
        mid: String(i),
        kind: producer.kind === 'audio' ? ('audio' as const) : ('video' as const),
      })),
    });
  }
}
