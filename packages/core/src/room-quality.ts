/**
 * RoomQualityController — the adaptive-quality runtime for a vidcall Room
 * (docs/architecture.md D5, docs/research/webrtc-js.md §5).
 * quality label papercut sweep: track <1h fixes via GitHub label `quality`
 * (Linear Quality Wednesdays — see plans/08-coherence-dx-docs-plan.md:20).
 *
 * Wires the pure `@mbsks/openrtc-quality` policy engine to live WebRTC senders:
 *
 *  - **Sampling**: polls `RTCPeerConnection.getStats()` on every peer every
 *    `intervalMs` (default 2s) while running **and** at least one local video
 *    track is published ("only when needed"). The default sampler aggregates
 *    candidate-pair / remote-inbound-rtp / outbound-rtp / inbound-rtp stats
 *    into the policy engine's `RTCStatsSnapshot` contract.
 *  - **Policy**: each snapshot is decorated with the captured device score and
 *    fed to the policy engine (`AdaptiveQualityController` by default). The
 *    controller never decides anything itself: it applies whatever tier the
 *    policy emits on `quality:changed`. Hysteresis (10s-stable upgrades,
 *    instant downgrades, one tier at a time) is entirely the policy's job, so
 *    the controller never spams senders.
 *  - **Application**: simulcast senders (3 encodings, low/mid/high, set up at
 *    `attachTrack`) are downgraded via
 *    `sender.setParameters({ encodings: [{ maxBitrate, scaleResolutionDownBy,
 *    maxFramerate, active }] })`; single-encoding senders fall back to
 *    `track.applyConstraints({ width, height, frameRate })`. The audio-only
 *    tier pauses the track / deactivates all encodings. Unsupported stacks
 *    never crash the room — every WebRTC call is caught and downgraded to a
 *    debug log.
 *  - **Device profile**: at `start()` (Room join) the controller captures
 *    `hardwareConcurrency` / `deviceMemory` (may be undefined) / mobile UA via
 *    `DeviceCapability.detect()` and combines it with the policy's
 *    initial-tier logic: the device's initial tier is applied as a cap
 *    (downgrade-only) and its score is attached to every snapshot so the
 *    policy never upgrades above the device's capability.
 *  - **Events**: `quality:changed` (tier, reason, direction, metrics) and
 *    `quality:warning` (`cpu-high`, `network-degraded`, `uplink-starved`,
 *    `device-capped`, `recovered`, `manual`, `monitor-error`) are emitted on
 *    the controller; the Room re-emits them as room events.
 *
 * Zero runtime dependencies: platform WebRTC APIs + `@mbsks/openrtc-quality` (an
 * in-workspace pure policy package, no WebRTC imports).
 */
import {
  AdaptiveQualityController,
  AUDIO_ONLY_TIER_ID,
  DEFAULT_QUALITY_TIERS,
  DeviceCapability,
  tierIndex,
} from '@mbsks/openrtc-quality';
import type {
  QualityChangeEvent,
  QualityLimitationReason,
  QualityTier,
  QualityWarningDirection,
  QualityWarningEvent,
  QualityWarningReason,
  RTCStatsSnapshot,
} from '@mbsks/openrtc-quality';
import type { DeviceProfile } from '@mbsks/openrtc-protocol';
import { TypedEmitter } from './events.ts';

// ------------------------------------------------------------------ events

/** Machine-readable warning codes emitted on `quality:warning`. */
export type RoomQualityWarningCode =
  | 'cpu-high'
  | 'network-degraded'
  | 'uplink-starved'
  | 'device-capped'
  | 'recovered'
  | 'manual'
  | 'monitor-error';

/** Local adaptive-quality tier change (re-emitted by the Room). */
export interface LocalQualityChangedEvent extends QualityChangeEvent {
  /** Local video track the change applies to (primary managed track). */
  trackId?: string;
}

/** Local adaptive-quality warning (re-emitted by the Room). */
export interface LocalQualityWarningEvent extends QualityWarningEvent {
  /** Machine-readable code for app toasts/badges. */
  code: RoomQualityWarningCode;
  /** Local video track the warning applies to (primary managed track). */
  trackId?: string;
}

/** Events emitted by the RoomQualityController (enriched room-level payloads). */
export type RoomQualityEventMap = {
  'quality:changed': [LocalQualityChangedEvent];
  'quality:warning': [LocalQualityWarningEvent];
};

/** Map a policy event to the warning code shown to the app. */
export function qualityWarningCode(event: QualityChangeEvent): RoomQualityWarningCode {
  if (event.reason === 'cpu') return 'cpu-high';
  if (event.reason === 'device') return 'device-capped';
  if (event.reason === 'recovery') return 'recovered';
  if (event.reason === 'manual') return 'manual';
  // network downgrades: severe (audio-only) is an uplink that's starved.
  return event.to === AUDIO_ONLY_TIER_ID ? 'uplink-starved' : 'network-degraded';
}

// --------------------------------------------------------------- interfaces

/** The stats source: one aggregated, sanitized snapshot per poll. */
export interface StatsSampler {
  /** Produce one `RTCStatsSnapshot` (e.g. one `getStats()` sweep). */
  sample(): Promise<RTCStatsSnapshot>;
}

/**
 * Minimal policy-engine surface the controller drives. `AdaptiveQualityController`
 * satisfies this structurally; tests may inject a fake to script decisions.
 */
export interface QualityPolicyEngine {
  readonly currentTier: QualityTier;
  readonly currentTierId: string;
  /** Tier ladder (default ladder assumed when undefined). */
  readonly tiers?: readonly QualityTier[];
  readonly direction?: QualityWarningDirection;
  /** Feed one stats snapshot; emits `quality:changed`/`quality:warning` on change. */
  tick(snapshot: RTCStatsSnapshot): unknown;
  /** Manual/device override (used for the device-profile initial tier). */
  setTier?(tierId: string, reason?: QualityWarningReason): unknown;
  on(event: 'quality:changed', listener: (event: QualityChangeEvent) => void): () => void;
  on(event: 'quality:warning', listener: (event: QualityWarningEvent) => void): () => void;
  stop?(): void;
  reset?(): void;
}

/** What the controller needs from the Room (Room implements this structurally). */
export interface RoomQualityHost {
  /** All live local senders across peer connections. */
  getSenders(): RTCRtpSender[];
  /** All live peer connections (the default sampler polls their stats). */
  getPeerConnections(): RTCPeerConnection[];
}

/** How simulcast encodings are produced for a video track (fake-safe). */
export type SimulcastEncoderFactory = (track: MediaStreamTrack) => RTCRtpEncodingParameters[];

/**
 * Default low/mid/high simulcast encodings (webrtc-js.md §5.3): the high
 * layer carries the full source, mid/low add scaleResolutionDownBy so the
 * encoder produces 720p/360p-ish layers.
 */
export function defaultSimulcastEncodings(_track?: MediaStreamTrack): RTCRtpEncodingParameters[] {
  return [
    { rid: 'f', maxBitrate: 2_500_000, maxFramerate: 30 },
    { rid: 'h', scaleResolutionDownBy: 2.0, maxBitrate: 1_200_000, maxFramerate: 30 },
    { rid: 'q', scaleResolutionDownBy: 4.0, maxBitrate: 400_000, maxFramerate: 15 },
  ];
}

export interface QualityEnvironment {
  window?: unknown;
  RTCPeerConnection?: unknown;
  navigator?: { userAgent?: string };
}

/**
 * Browser detection for the default `enabled` switch: quality runs by default
 * only where the platform WebRTC stack + navigator exist (never in Node/test
 * runners). Pass `quality: { enabled: true }` to force it on in Node (e.g.
 * werift/wrtc peers) — the guard mirrors the recording facade's behavior.
 */
export function qualityEnvironmentSupported(env: QualityEnvironment = globalThis): boolean {
  return (
    typeof env.window !== 'undefined' &&
    typeof env.RTCPeerConnection === 'function' &&
    typeof env.navigator !== 'undefined'
  );
}

/**
 * Send-side simulcast support (webrtc-js.md §5.3): Chrome/Edge/Firefox yes,
 * Safari (macOS/iOS) no. Feature detection is UA-based; injectable via the
 * `simulcast` config option.
 */
export function simulcastSupported(env: QualityEnvironment = globalThis): boolean {
  if (typeof env.RTCPeerConnection !== 'function') return false;
  const ua = env.navigator?.userAgent ?? '';
  const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua);
  return !isSafari;
}

// ------------------------------------------------------------------ config

export interface RoomQualityConfig {
  /**
   * Master switch. Default: `qualityEnvironmentSupported()` (browsers only;
   * auto-disabled in Node/test environments).
   */
  enabled?: boolean;
  /** Stats sampler override (tests inject scripted degraded/healthy sequences). */
  sampler?: StatsSampler;
  /** Policy engine override; default `AdaptiveQualityController`. */
  policy?: QualityPolicyEngine;
  /** Poll interval in ms (default 2000; "only when needed" — skipped without video). */
  intervalMs?: number;
  /**
   * Simulcast: `false` forces the single-encoding path, a factory customizes
   * the encodings, `undefined` auto-detects browser support.
   */
  simulcast?: false | SimulcastEncoderFactory;
  /** Device capability override (tests / backend-provided device profiles). */
  deviceCapability?: DeviceCapability;
}

export interface RoomQualityOptions extends RoomQualityConfig {
  /** The Room this controller drives (structural stub in unit tests). */
  room: RoomQualityHost;
  debug?: (message: string, data?: unknown) => void;
}

// --------------------------------------------------------------- controller

export class RoomQualityController extends TypedEmitter<RoomQualityEventMap> {
  private readonly host: RoomQualityHost;
  private readonly sampler: StatsSampler;
  private readonly policy: QualityPolicyEngine;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly simulcastEnabled: boolean;
  private readonly simulcastFactory: SimulcastEncoderFactory;
  private readonly direction: QualityWarningDirection;
  private readonly debug: (message: string, data?: unknown) => void;

  private readonly videoTracks = new Set<MediaStreamTrack>();
  private readonly unsubscribePolicy: Array<() => void> = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private polling = false;
  private deviceCapability: DeviceCapability | null = null;

  constructor(options: RoomQualityOptions) {
    super();
    this.host = options.room;
    this.enabled = options.enabled ?? qualityEnvironmentSupported();
    this.intervalMs = options.intervalMs ?? 2000;
    this.debug = options.debug ?? (() => {});
    this.policy = options.policy ?? new AdaptiveQualityController();
    this.direction = this.policy.direction ?? 'send';
    this.sampler =
      options.sampler ??
      new RoomStatsSampler({ getPeerConnections: () => this.host.getPeerConnections() });
    // An explicit factory forces simulcast on (fake-safe); otherwise auto-detect.
    this.simulcastEnabled =
      typeof options.simulcast === 'function'
        ? true
        : options.simulcast !== false && simulcastSupported();
    this.simulcastFactory =
      typeof options.simulcast === 'function' ? options.simulcast : defaultSimulcastEncodings;
    this.deviceCapability = options.deviceCapability ?? null;
    if (this.enabled) {
      this.unsubscribePolicy.push(
        this.policy.on('quality:changed', (event) => this.handleQualityChanged(event)),
        this.policy.on('quality:warning', (event) => this.handleQualityWarning(event)),
      );
    }
  }

  // -------------------------------------------------------------- accessors

  /** True when the controller is active in this environment. */
  get available(): boolean {
    return this.enabled;
  }

  /** True between `start()` and `stop()` (sampling is live). */
  get running(): boolean {
    return this.started;
  }

  /** The policy's current tier id (undefined when disabled). */
  get currentTierId(): string | undefined {
    return this.enabled ? this.policy.currentTierId : undefined;
  }

  /** The captured device capability (undefined until `start()`/explicit config). */
  get deviceProfile(): DeviceProfile | undefined {
    return this.deviceCapability?.profile;
  }

  /** Number of local video tracks under adaptive control. */
  get managedTrackCount(): number {
    return this.videoTracks.size;
  }

  // -------------------------------------------------------------- lifecycle

  /** Start sampling + policy application (call on Room.join()). Idempotent. */
  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    if (this.deviceCapability === null) this.captureDeviceCapability();
    this.applyInitialTier();
    this.interval = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    this.unrefInterval();
  }

  /** Stop sampling + clear the poll timer (call on Room.leave()). Idempotent. */
  stop(): void {
    this.started = false;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run one sampling cycle now (test hook; also useful for immediate
   * re-evaluation, e.g. after an app-level event).
   */
  async pollNow(): Promise<void> {
    if (!this.enabled || !this.started) return;
    await this.poll();
  }

  /** Register a published local video track (simulcast setup + initial tier). */
  async attachTrack(track: MediaStreamTrack): Promise<void> {
    if (!this.enabled || track.kind !== 'video') return;
    this.videoTracks.add(track);
    for (const sender of this.sendersFor(track)) {
      try {
        await this.setupSimulcast(sender);
        await this.applyTierToSender(sender, this.policy.currentTier);
      } catch (err) {
        // A broken sender must never take publishing down with it.
        this.debug('quality:attach-failed', err);
      }
    }
  }

  /** Forget a published local track (Room.unpublish). */
  detachTrack(track: MediaStreamTrack): void {
    this.videoTracks.delete(track);
  }

  // -------------------------------------------------------------- internals

  private captureDeviceCapability(): void {
    this.deviceCapability = DeviceCapability.detect();
    this.debug('quality:device-profile', this.deviceCapability.profile);
  }

  /**
   * Combine the device profile with the policy's initial-tier logic: the
   * device's initial tier is a **cap** — only ever downgrade the policy's
   * default start (strong devices stay where the policy starts them; the
   * device score in every snapshot keeps the policy from over-upgrading).
   */
  private applyInitialTier(): void {
    if (!this.deviceCapability || typeof this.policy.setTier !== 'function') return;
    const tiers = this.policy.tiers ?? DEFAULT_QUALITY_TIERS;
    const initial = this.deviceCapability.initialTier(tiers);
    const currentIdx = tierIndex(tiers, this.policy.currentTierId);
    const initialIdx = tierIndex(tiers, initial.id);
    if (initialIdx > currentIdx) {
      this.policy.setTier(initial.id, 'device');
    }
  }

  private async poll(): Promise<void> {
    if (!this.enabled || !this.started) return;
    if (this.polling) return;
    if (this.videoTracks.size === 0) return; // sample only when needed
    this.polling = true;
    try {
      const snapshot = await this.sampler.sample();
      this.decorate(snapshot);
      this.policy.tick(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.debug('quality:poll-error', err);
      this.emit('quality:warning', {
        from: this.policy.currentTierId,
        to: this.policy.currentTierId,
        reason: 'device',
        direction: this.direction,
        tier: this.policy.currentTier,
        stats: { ts: Date.now() },
        level: 'info',
        message: `Quality monitor error: ${message}`,
        code: 'monitor-error',
      });
    } finally {
      this.polling = false;
    }
  }

  /** Attach the device score so the policy clamps to the device capability. */
  private decorate(snapshot: RTCStatsSnapshot): void {
    if (this.deviceCapability && snapshot.deviceScore === undefined) {
      snapshot.deviceScore = this.deviceCapability.score;
    }
  }

  private handleQualityChanged(event: QualityChangeEvent): void {
    void this.applyTier(event.tier).catch((err) => this.debug('quality:apply-failed', err));
    this.emit('quality:changed', { ...event, trackId: this.primaryTrackId() });
  }

  private handleQualityWarning(event: QualityWarningEvent): void {
    this.emit('quality:warning', {
      ...event,
      code: qualityWarningCode(event),
      trackId: this.primaryTrackId(),
    });
  }

  /** Apply a tier to every managed track's senders (all peers in the mesh). */
  private async applyTier(tier: QualityTier): Promise<void> {
    if (!this.enabled) return;
    for (const track of this.videoTracks) {
      for (const sender of this.sendersFor(track)) {
        try {
          await this.applyTierToSender(sender, tier);
        } catch (err) {
          this.debug('quality:apply-failed', err);
        }
      }
    }
  }

  private sendersFor(track: MediaStreamTrack): RTCRtpSender[] {
    return this.host.getSenders().filter((sender) => sender.track === track);
  }

  private primaryTrackId(): string | undefined {
    return this.videoTracks.values().next().value?.id;
  }

  /** Configure low/mid/high simulcast encodings on a fresh video sender. */
  private async setupSimulcast(sender: RTCRtpSender): Promise<void> {
    if (!this.simulcastEnabled || !sender.track || sender.track.kind !== 'video') return;
    const params = sender.getParameters();
    const encodings = params.encodings ?? [];
    if (encodings.length > 1) return; // already configured
    const next = this.simulcastFactory(sender.track);
    if (!next || next.length < 2) return;
    await sender.setParameters({ ...params, encodings: next });
    this.debug(
      'quality:simulcast-setup',
      next.map((encoding) => encoding.rid),
    );
  }

  private async applyTierToSender(sender: RTCRtpSender, tier: QualityTier): Promise<void> {
    const params = sender.getParameters();
    const encodings = params.encodings ?? [];
    if (encodings.length > 1) {
      await this.applySimulcastTier(sender, params, encodings, tier);
    } else {
      await this.applySingleTier(sender, tier);
    }
  }

  /**
   * Simulcast path: keep the layers the tier needs active, deactivate the
   * higher ones, and cap maxBitrate / maxFramerate / scaleResolutionDownBy of
   * the active encodings to the tier (research §5.4/§5.5).
   */
  private async applySimulcastTier(
    sender: RTCRtpSender,
    params: RTCRtpSendParameters,
    encodings: RTCRtpEncodingParameters[],
    tier: QualityTier,
  ): Promise<void> {
    // tier.simulcastLayer = index of the highest layer that stays active
    // (0 = high). Clamp so 2-encoding setups never deactivate everything.
    const activeFrom = tier.audioOnly
      ? encodings.length
      : Math.min(tier.simulcastLayer ?? 0, encodings.length - 1);
    const scale = tier.height > 0 ? 1080 / tier.height : 4;
    const next: RTCRtpEncodingParameters[] = encodings.map((encoding, index) => {
      if (index < activeFrom) return { ...encoding, active: false };
      return {
        ...encoding,
        active: true,
        maxBitrate:
          tier.maxBitrateKbps > 0
            ? Math.min(encoding.maxBitrate ?? Infinity, tier.maxBitrateKbps * 1000)
            : encoding.maxBitrate,
        maxFramerate:
          tier.maxFramerate > 0
            ? Math.min(encoding.maxFramerate ?? Infinity, tier.maxFramerate)
            : encoding.maxFramerate,
        scaleResolutionDownBy:
          tier.width > 0
            ? Math.max(encoding.scaleResolutionDownBy ?? 1, scale)
            : encoding.scaleResolutionDownBy,
      };
    });
    await sender.setParameters({
      ...params,
      degradationPreference: tier.degradationPreference ?? params.degradationPreference,
      encodings: next,
    });
  }

  /**
   * Single-encoding path (Safari / simulcast disabled): cap resolution and
   * framerate via `track.applyConstraints`. The audio-only tier pauses the
   * track (applyConstraints cannot express "no video").
   */
  private async applySingleTier(sender: RTCRtpSender, tier: QualityTier): Promise<void> {
    const track = sender.track;
    if (!track) return;
    if (tier.audioOnly) {
      track.enabled = false;
      return;
    }
    track.enabled = true;
    await track.applyConstraints({
      width: { max: tier.width },
      height: { max: tier.height },
      frameRate: { max: tier.maxFramerate },
    });
  }

  private unrefInterval(): void {
    const timer = this.interval as { unref?: () => void } | null;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
}

// ------------------------------------------------------- default stats sampler

export interface RoomStatsSamplerOptions {
  /** Peer connections to poll each cycle. */
  getPeerConnections: () => RTCPeerConnection[];
  /** Clock (default `Date.now`). */
  now?: () => number;
}

/**
 * Default stats sampler: one `getStats()` sweep over every live peer
 * connection, aggregated into the policy engine's `RTCStatsSnapshot` contract
 * (webrtc-js.md §5.2). Aggregation takes the worst value across peers (max
 * RTT/loss/jitter/bitrate) so any degraded peer drives a downgrade.
 */
export class RoomStatsSampler implements StatsSampler {
  private readonly getPeerConnections: () => RTCPeerConnection[];
  private readonly now: () => number;

  constructor(options: RoomStatsSamplerOptions) {
    this.getPeerConnections = options.getPeerConnections;
    this.now = options.now ?? (() => Date.now());
  }

  async sample(): Promise<RTCStatsSnapshot> {
    const snapshot: RTCStatsSnapshot = { ts: this.now() };
    for (const pc of this.getPeerConnections()) {
      if (pc.connectionState === 'closed') continue;
      let report: RTCStatsReport;
      try {
        report = await pc.getStats();
      } catch {
        continue; // a broken peer must not take the monitor down
      }
      this.merge(snapshot, report);
    }
    return snapshot;
  }

  private merge(snapshot: RTCStatsSnapshot, report: RTCStatsReport): void {
    for (const stat of report.values()) {
      switch (stat.type) {
        case 'candidate-pair': {
          const pair = stat as RTCIceCandidatePairStats;
          if (pair.state === 'succeeded' || pair.nominated === true) {
            if (typeof pair.currentRoundTripTime === 'number') {
              snapshot.rttMs = Math.max(snapshot.rttMs ?? 0, pair.currentRoundTripTime * 1000);
            }
            if (typeof pair.availableOutgoingBitrate === 'number') {
              snapshot.availableOutgoingBitrateBps = Math.max(
                snapshot.availableOutgoingBitrateBps ?? 0,
                pair.availableOutgoingBitrate,
              );
            }
          }
          break;
        }
        case 'remote-inbound-rtp': {
          const remote = stat as {
            roundTripTime?: number;
            packetsLost?: number;
            packetsReceived?: number;
            fractionLost?: number;
          };
          if (typeof remote.roundTripTime === 'number') {
            snapshot.rttMs = Math.max(snapshot.rttMs ?? 0, remote.roundTripTime * 1000);
          }
          const fractionLost = remote.fractionLost;
          if (typeof fractionLost === 'number') {
            snapshot.lossRate = Math.max(snapshot.lossRate ?? 0, fractionLost);
          } else if (typeof remote.packetsLost === 'number') {
            const total = (remote.packetsReceived ?? 0) + remote.packetsLost;
            if (total > 0) {
              snapshot.lossRate = Math.max(snapshot.lossRate ?? 0, remote.packetsLost / total);
            }
          }
          break;
        }
        case 'outbound-rtp': {
          const outbound = stat as RTCOutboundRtpStreamStats;
          if (outbound.kind === 'video') {
            if (outbound.qualityLimitationReason) {
              snapshot.qualityLimitationReason = outbound.qualityLimitationReason;
            }
            if (outbound.qualityLimitationDurations) {
              snapshot.qualityLimitationDurationsMs = {
                ...(outbound.qualityLimitationDurations as Partial<
                  Record<QualityLimitationReason, number>
                >),
              };
            }
            if (typeof outbound.totalEncodeTime === 'number') {
              snapshot.totalEncodeTimeMs = Math.max(
                snapshot.totalEncodeTimeMs ?? 0,
                outbound.totalEncodeTime,
              );
            }
            if (typeof outbound.framesEncoded === 'number') {
              snapshot.framesEncoded = Math.max(
                snapshot.framesEncoded ?? 0,
                outbound.framesEncoded,
              );
            }
            if (typeof outbound.framesPerSecond === 'number') {
              snapshot.framesPerSecond = Math.max(
                snapshot.framesPerSecond ?? 0,
                outbound.framesPerSecond,
              );
            }
          }
          break;
        }
        case 'inbound-rtp': {
          const inbound = stat as RTCInboundRtpStreamStats;
          if (typeof inbound.jitter === 'number') {
            snapshot.jitterMs = Math.max(snapshot.jitterMs ?? 0, inbound.jitter * 1000);
          }
          if (typeof inbound.framesDropped === 'number') {
            snapshot.framesDropped = Math.max(snapshot.framesDropped ?? 0, inbound.framesDropped);
          }
          break;
        }
        default:
          break;
      }
    }
  }
}
