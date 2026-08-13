/**
 * FakeSender + FakeSenderStats — recordable WebRTC send-side fakes for the
 * adaptive-quality tests (packages/core/test/room-quality.test.ts).
 *
 * `FakeSender` records every `setParameters` call (deep-cloned) and every
 * `getStats` call; `FakeSenderStats` builds a synthetic `RTCStatsReport`
 * (outbound-rtp / remote-inbound-rtp / candidate-pair / inbound-rtp entries)
 * from a plain input object, so the stats sampler can be unit-tested without a
 * browser. Deliberately structural (no `implements RTCRtpSender`), matching
 * `FakeRTCPeerConnection`.
 */

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

/** Plain input for a synthetic RTCStatsReport (all values in SI units). */
export interface FakeSenderStatsInput {
  kind?: 'video' | 'audio';
  /** candidate-pair.currentRoundTripTime + remote-inbound-rtp.roundTripTime (ms). */
  rttMs?: number;
  /** candidate-pair.availableOutgoingBitrate (bps) — GCC estimate. */
  availableOutgoingBitrateBps?: number;
  /** remote-inbound-rtp.fractionLost (0..1). */
  lossRate?: number;
  /** remote-inbound-rtp.packetsLost (fallback loss computation). */
  packetsLost?: number;
  /** remote-inbound-rtp.packetsReceived. */
  packetsReceived?: number;
  /** inbound-rtp.jitter (ms). */
  jitterMs?: number;
  /** outbound-rtp.qualityLimitationReason. */
  qualityLimitationReason?: 'none' | 'cpu' | 'bandwidth' | 'other';
  /** outbound-rtp.qualityLimitationDurations (cumulative ms per reason). */
  qualityLimitationDurationsMs?: Partial<Record<string, number>>;
  /** outbound-rtp.totalEncodeTime (cumulative ms). */
  totalEncodeTimeMs?: number;
  /** outbound-rtp.framesEncoded (cumulative). */
  framesEncoded?: number;
  /** outbound-rtp.framesPerSecond (instant). */
  framesPerSecond?: number;
  /** inbound-rtp.framesDropped (cumulative). */
  framesDropped?: number;
}

/**
 * Builds a synthetic `RTCStatsReport` matching the shape a real browser
 * exposes after `RTCPeerConnection.getStats()`.
 */
export class FakeSenderStats {
  private readonly input: FakeSenderStatsInput;

  constructor(input: FakeSenderStatsInput = {}) {
    this.input = input;
  }

  toReport(): RTCStatsReport {
    const input = this.input;
    const report = new Map<string, RTCStats>();
    const ts = 1_700_000_000_000;

    if (
      input.qualityLimitationReason !== undefined ||
      input.qualityLimitationDurationsMs !== undefined ||
      input.totalEncodeTimeMs !== undefined ||
      input.framesEncoded !== undefined ||
      input.framesPerSecond !== undefined
    ) {
      report.set('outbound-rtp-video', {
        id: 'outbound-rtp-video',
        timestamp: ts,
        type: 'outbound-rtp',
        kind: input.kind ?? 'video',
        ...(input.qualityLimitationReason !== undefined
          ? { qualityLimitationReason: input.qualityLimitationReason }
          : {}),
        ...(input.qualityLimitationDurationsMs !== undefined
          ? { qualityLimitationDurations: input.qualityLimitationDurationsMs }
          : {}),
        ...(input.totalEncodeTimeMs !== undefined
          ? { totalEncodeTime: input.totalEncodeTimeMs }
          : {}),
        ...(input.framesEncoded !== undefined ? { framesEncoded: input.framesEncoded } : {}),
        ...(input.framesPerSecond !== undefined ? { framesPerSecond: input.framesPerSecond } : {}),
      } as unknown as RTCStats);
    }

    if (
      input.rttMs !== undefined ||
      input.lossRate !== undefined ||
      input.packetsLost !== undefined ||
      input.packetsReceived !== undefined
    ) {
      report.set('remote-inbound-rtp-video', {
        id: 'remote-inbound-rtp-video',
        timestamp: ts,
        type: 'remote-inbound-rtp',
        ...(input.rttMs !== undefined ? { roundTripTime: input.rttMs / 1000 } : {}),
        ...(input.lossRate !== undefined ? { fractionLost: input.lossRate } : {}),
        ...(input.packetsLost !== undefined ? { packetsLost: input.packetsLost } : {}),
        ...(input.packetsReceived !== undefined ? { packetsReceived: input.packetsReceived } : {}),
      } as unknown as RTCStats);
    }

    if (input.rttMs !== undefined || input.availableOutgoingBitrateBps !== undefined) {
      report.set('candidate-pair-0', {
        id: 'candidate-pair-0',
        timestamp: ts,
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        ...(input.rttMs !== undefined ? { currentRoundTripTime: input.rttMs / 1000 } : {}),
        ...(input.availableOutgoingBitrateBps !== undefined
          ? { availableOutgoingBitrate: input.availableOutgoingBitrateBps }
          : {}),
      } as unknown as RTCStats);
    }

    if (input.jitterMs !== undefined || input.framesDropped !== undefined) {
      report.set('inbound-rtp-video', {
        id: 'inbound-rtp-video',
        timestamp: ts,
        type: 'inbound-rtp',
        kind: input.kind ?? 'video',
        ...(input.jitterMs !== undefined ? { jitter: input.jitterMs / 1000 } : {}),
        ...(input.framesDropped !== undefined ? { framesDropped: input.framesDropped } : {}),
      } as unknown as RTCStats);
    }

    return report as unknown as RTCStatsReport;
  }
}

/**
 * A recordable `RTCRtpSender` for quality tests: `setParameters` calls are
 * deep-cloned into `setParametersCalls`, `getStats` increments `getStatsCalls`
 * and returns an optional `FakeSenderStats` report.
 */
export class FakeSender {
  readonly track: MediaStreamTrack | null;
  transport: RTCDtlsTransport | null = null;
  transform: RTCRtpTransform | null = null;
  readonly dtmf: RTCDTMFSender | null = null;
  /** Every setParameters call, deep-cloned (assertions read this). */
  readonly setParametersCalls: RTCRtpSendParameters[] = [];
  private readonly stats?: FakeSenderStats;
  private parameters: RTCRtpSendParameters;
  getStatsCalls = 0;

  constructor(track: MediaStreamTrack | null, options: { stats?: FakeSenderStats } = {}) {
    this.track = track;
    this.stats = options.stats;
    void this.stats;
    this.parameters = {
      codecs: [],
      encodings: [],
      headerExtensions: [],
      rtcp: { cname: '', reducedSize: false },
      transactionId: nextId('txn'),
    };
  }

  /** Current encodings (convenience for assertions). */
  get encodings(): RTCRtpEncodingParameters[] {
    return this.parameters.encodings ?? [];
  }

  async replaceTrack(withTrack: MediaStreamTrack | null): Promise<void> {
    (this as { track: MediaStreamTrack | null }).track = withTrack;
  }

  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.parameters);
  }

  async setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.parameters = structuredClone(parameters);
    this.setParametersCalls.push(structuredClone(parameters));
  }

  async getStats(): Promise<RTCStatsReport> {
    this.getStatsCalls += 1;
    return Promise.resolve(this.stats?.toReport() ?? (new Map() as unknown as RTCStatsReport));
  }

  setStreams(..._streams: MediaStream[]): void {
    /* no-op */
  }
}
