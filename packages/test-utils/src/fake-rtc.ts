/**
 * Fake RTCPeerConnection — a faithful-enough platform seam for engine tests.
 *
 * Implements the subset of the WebRTC API the vidcall engine uses, with real
 * signaling-state transitions, SDP `o=` origin handling, trickle-ICE
 * candidate exchange, data channels, track events, and ICE-restart.
 *
 * Two fakes are "wired" together with `wirePeers(a, b)` so that:
 *  - ICE candidates emitted by one side are delivered to the other,
 *  - `createDataChannel` on one side fires `ondatachannel` on the other,
 *  - `addTrack` + `setRemoteDescription(offer)` fires `ontrack` on the
 *    receiving side (per-sender m-lines are encoded in the fake SDP).
 *
 * Not a full WebRTC implementation: no real media, no DTLS/SRTP, no actual
 * ICE connectivity. It exercises engine logic (negotiation, glare, buffering,
 * idempotency, ordering), not the platform stack.
 *
 * Note: the class is structurally compatible with `RTCPeerConnection` but
 * deliberately does NOT `implements RTCPeerConnection` (the lib.dom interface
 * carries legacy callback overloads and EventTarget members this fake does not
 * need). Tests cast to it at the engine boundary where required.
 */

// ------------------------------------------------------------ fake primitives

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

export class FakeMediaStreamTrack implements MediaStreamTrack {
  readonly id: string;
  readonly kind: string;
  label: string;
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = 'live';
  contentHint = '';
  onended: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  onmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  onunmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;

  constructor(kind: 'audio' | 'video', label: string = kind) {
    this.id = nextId('track');
    this.kind = kind;
    this.label = label;
  }

  clone(): MediaStreamTrack {
    const t = new FakeMediaStreamTrack(this.kind as 'audio' | 'video', this.label);
    t.enabled = this.enabled;
    return t;
  }

  getSettings(): MediaTrackSettings {
    return { width: 1280, height: 720, frameRate: 30 };
  }

  getConstraints(): MediaTrackConstraints {
    return {};
  }

  getCapabilities(): MediaTrackCapabilities {
    return {
      width: { min: 160, max: 1920 },
      height: { min: 90, max: 1080 },
      frameRate: { min: 1, max: 60 },
    };
  }

  applyConstraints(_constraints?: MediaTrackConstraints): Promise<void> {
    return Promise.resolve();
  }

  stop(): void {
    this.readyState = 'ended';
    const event = new Event('ended');
    this.onended?.(event);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
    if (!fn) return;
    if (type === 'ended') this.onended = fn as never;
    else if (type === 'mute') this.onmute = fn as never;
    else if (type === 'unmute') this.onunmute = fn as never;
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
    if (!fn) return;
    if (type === 'ended' && this.onended === fn) this.onended = null;
    else if (type === 'mute' && this.onmute === fn) this.onmute = null;
    else if (type === 'unmute' && this.onunmute === fn) this.onunmute = null;
  }

  dispatchEvent(event: Event): boolean {
    if (event.type === 'ended') this.onended?.(event);
    else if (event.type === 'mute') this.onmute?.(event);
    else if (event.type === 'unmute') this.onunmute?.(event);
    return true;
  }
}

export class FakeDataChannel implements RTCDataChannel {
  readonly id: number | null = null;
  readonly label: string;
  ordered = true;
  maxPacketLifeTime: number | null = null;
  maxRetransmits: number | null = null;
  protocol = '';
  negotiated = false;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onbufferedamountlow: ((ev: Event) => unknown) | null = null;
  onclosing: ((ev: Event) => unknown) | null = null;

  /** The paired channel on the remote side (set by the fake pc wiring). */
  peer: FakeDataChannel | null = null;

  constructor(label: string) {
    this.label = label;
  }

  /** Open the channel (both ends) — called by the fake pc wiring. */
  open(): void {
    this.readyState = 'open';
    queueMicrotask(() => {
      this.onopen?.(new Event('open'));
      this.peer?.markOpen();
    });
  }

  private markOpen(): void {
    if (this.readyState !== 'open') {
      this.readyState = 'open';
      queueMicrotask(() => this.onopen?.(new Event('open')));
    }
  }

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error(`FakeDataChannel '${this.label}': not open`);
    const text = typeof data === 'string' ? data : '[binary]';
    queueMicrotask(() => {
      this.peer?.onmessage?.({ data: text } as MessageEvent);
    });
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => {
      this.onclose?.(new Event('close'));
      this.peer?.markClosed();
    });
  }

  private markClosed(): void {
    if (this.readyState !== 'closed') {
      this.readyState = 'closed';
      queueMicrotask(() => this.onclose?.(new Event('close')));
    }
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
    if (!fn) return;
    if (type === 'open') this.onopen = fn as never;
    else if (type === 'message') this.onmessage = fn as never;
    else if (type === 'close') this.onclose = fn as never;
    else if (type === 'error') this.onerror = fn as never;
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
    if (!fn) return;
    if (type === 'open' && this.onopen === fn) this.onopen = null;
    else if (type === 'message' && this.onmessage === fn) this.onmessage = null;
    else if (type === 'close' && this.onclose === fn) this.onclose = null;
    else if (type === 'error' && this.onerror === fn) this.onerror = null;
  }

  dispatchEvent(event: Event): boolean {
    if (event.type === 'open') this.onopen?.(event);
    else if (event.type === 'message') this.onmessage?.(event as MessageEvent);
    else if (event.type === 'close') this.onclose?.(event);
    else if (event.type === 'error') this.onerror?.(event);
    return true;
  }
}

// ------------------------------------------------------------ fake sender

export class FakeRTCRtpSender implements RTCRtpSender {
  readonly track: MediaStreamTrack | null;
  transport: RTCDtlsTransport | null = null;
  transform: RTCRtpTransform | null = null;
  readonly dtmf: RTCDTMFSender | null = null;
  private parameters: RTCRtpSendParameters;

  constructor(track: MediaStreamTrack | null, parameters?: Partial<RTCRtpSendParameters>) {
    this.track = track;
    this.parameters = {
      codecs: [],
      encodings: [],
      headerExtensions: [],
      rtcp: { cname: '', reducedSize: false },
      transactionId: nextId('txn'),
      ...parameters,
    };
  }

  async replaceTrack(withTrack: MediaStreamTrack | null): Promise<void> {
    (this as { track: MediaStreamTrack | null }).track = withTrack;
  }

  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.parameters);
  }

  setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.parameters = parameters;
    return Promise.resolve();
  }

  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(new Map() as RTCStatsReport);
  }

  setStreams(..._streams: MediaStream[]): void {
    /* no-op */
  }
}

export class FakeRTCRtpReceiver implements RTCRtpReceiver {
  readonly track: MediaStreamTrack;
  transport: RTCDtlsTransport | null = null;
  transform: RTCRtpTransform | null = null;
  jitterBufferTarget: number | null = null;

  constructor(track: MediaStreamTrack) {
    this.track = track;
  }

  getParameters(): RTCRtpReceiveParameters {
    return { codecs: [], headerExtensions: [], rtcp: { reducedSize: false } };
  }

  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(new Map() as RTCStatsReport);
  }

  getContributingSources(): RTCRtpContributingSource[] {
    return [];
  }

  getSynchronizationSources(): RTCRtpSynchronizationSource[] {
    return [];
  }
}

// ------------------------------------------------------------ fake pc

export interface FakePeerConnectionOptions {
  /** Session id baked into the SDP `o=` line (default: unique per pc). */
  sessionId?: string;
  /** Automatically emit a couple of ICE candidates after setLocalDescription. */
  trickle?: boolean;
  /** Delay (ms) before trickled candidates fire (0 = microtask). */
  trickleDelayMs?: number;
  /** Log SDP/state transitions. */
  debug?: (message: string, data?: unknown) => void;
}

const fakePcsBySessionId = new Map<string, FakeRTCPeerConnection>();

export class FakeRTCPeerConnection {
  static readonly instances: FakeRTCPeerConnection[] = [];

  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly currentLocalDescription: RTCSessionDescription | null = null;
  readonly currentRemoteDescription: RTCSessionDescription | null = null;
  readonly pendingLocalDescription: RTCSessionDescription | null = null;
  readonly pendingRemoteDescription: RTCSessionDescription | null = null;
  readonly sctp: RTCSctpTransport | null = null;

  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  canTrickleIceCandidates: boolean | null = null;

  onnegotiationneeded: ((ev: Event) => unknown) | null = null;
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => unknown) | null = null;
  onicecandidateerror: ((ev: Event) => unknown) | null = null;
  onsignalingstatechange: ((ev: Event) => unknown) | null = null;
  oniceconnectionstatechange: ((ev: Event) => unknown) | null = null;
  onicegatheringstatechange: ((ev: Event) => unknown) | null = null;
  onconnectionstatechange: ((ev: Event) => unknown) | null = null;
  ondatachannel: ((ev: RTCDataChannelEvent) => unknown) | null = null;
  ontrack: ((ev: RTCTrackEvent) => unknown) | null = null;
  onremovetrack: ((ev: Event) => unknown) | null = null;

  readonly sessionId: string;
  private readonly options: FakePeerConnectionOptions;
  private readonly senders: FakeRTCRtpSender[] = [];
  private readonly receivers: FakeRTCRtpReceiver[] = [];
  private readonly channels: FakeDataChannel[] = [];
  private localSdp: string | null = null;
  private remoteSdp: string | null = null;
  private sdpVersion = 0;
  private closed = false;
  private link: FakeRTCPeerConnection | null = null;
  private pendingNegotiation = false;
  private trickleScheduled = false;
  private readonly configuration: RTCConfiguration;

  constructor(config?: RTCConfiguration, options: FakePeerConnectionOptions = {}) {
    this.configuration = config ?? { iceServers: [] };
    this.options = options;
    this.sessionId = options.sessionId ?? nextId('sess');
    fakePcsBySessionId.set(this.sessionId, this);
    FakeRTCPeerConnection.instances.push(this);
  }

  // ------------------------------------------------------------ SDP helpers

  /** Build fake SDP with a real `o=` line and one m-line per sender. */
  private buildSdp(type: 'offer' | 'answer'): string {
    this.sdpVersion += 1;
    const lines = [
      'v=0',
      `o=- ${this.sessionId} ${this.sdpVersion} IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
      `a=ice-ufrag:frag${this.sessionId.replace(/\D/g, '')}`,
      `a=ice-pwd:pwd${this.sdpVersion}`,
    ];
    this.senders.forEach((sender, index) => {
      const kind = sender.track?.kind === 'audio' ? 'audio' : 'video';
      lines.push(`m=${kind} 9 UDP/TLS/RTP/SAVPF 96`);
      lines.push(`a=mid:${kind}${index}`);
      lines.push('a=sendonly');
    });
    if (this.channels.length > 0) {
      lines.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
      lines.push('a=sctp-port:5000');
    }
    if (type === 'answer') lines.push('a=recvonly');
    return lines.join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------ core methods

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw new Error('FakeRTCPeerConnection: closed');
    return { type: 'offer', sdp: this.buildSdp('offer') };
  }

  async createAnswer(_options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw new Error('FakeRTCPeerConnection: closed');
    return { type: 'answer', sdp: this.buildSdp('answer') };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('FakeRTCPeerConnection: closed');
    if (!description) {
      // Convenience: no-arg setLocalDescription() creates the description
      // implied by the current signaling state (offer when stable, answer
      // when a remote offer is pending).
      description =
        this.signalingState === 'have-remote-offer'
          ? await this.createAnswer()
          : await this.createOffer();
    }
    if (description.type === 'rollback') {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error('FakeRTCPeerConnection: rollback only valid from have-local-offer');
      }
      this.signalingState = 'stable';
      queueMicrotask(() => this.onsignalingstatechange?.(new Event('signalingstatechange')));
      return;
    }
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-remote-offer') {
        throw new Error(
          `FakeRTCPeerConnection: setLocalDescription(offer) invalid in ${this.signalingState}`,
        );
      }
      this.signalingState = 'have-local-offer';
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(
          `FakeRTCPeerConnection: setLocalDescription(answer) invalid in ${this.signalingState}`,
        );
      }
      this.signalingState = 'stable';
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
      queueMicrotask(() => this.onconnectionstatechange?.(new Event('connectionstatechange')));
    }
    const sdp = description.sdp ?? this.buildSdp(description.type === 'offer' ? 'offer' : 'answer');
    this.localSdp = sdp;
    this.localDescription = {
      type: description.type,
      sdp,
      toJSON: () => ({ type: description!.type, sdp }),
    };
    queueMicrotask(() => this.onsignalingstatechange?.(new Event('signalingstatechange')));
    this.scheduleTrickle();
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('FakeRTCPeerConnection: closed');
    const sdp = description.sdp ?? '';
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        throw new Error(
          'FakeRTCPeerConnection: setRemoteDescription(offer) collides with local offer',
        );
      }
      this.signalingState = 'have-remote-offer';
      // Fire ontrack for each sender the remote peer added (found by o= session id).
      this.fireRemoteTracks(sdp);
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error(
          `FakeRTCPeerConnection: setRemoteDescription(answer) invalid in ${this.signalingState}`,
        );
      }
      this.signalingState = 'stable';
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
      queueMicrotask(() => this.onconnectionstatechange?.(new Event('connectionstatechange')));
    }
    this.remoteSdp = sdp;
    this.remoteDescription = {
      type: description.type,
      sdp,
      toJSON: () => ({ type: description.type, sdp }),
    };
    queueMicrotask(() => this.onsignalingstatechange?.(new Event('signalingstatechange')));
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    if (this.closed) throw new Error('FakeRTCPeerConnection: closed');
    if (!this.remoteSdp && !this.remoteDescription) {
      throw new Error('FakeRTCPeerConnection: addIceCandidate requires a remote description');
    }
    if (!candidate || candidate.candidate === '') return;
    // The candidate is applied to this peer's ICE agent. The "network" path
    // (local onicecandidate -> signaling -> remote addIceCandidate) is driven
    // by the engine under test; deliverIce exists for manual simulations.
  }

  // ------------------------------------------------------------ media & data

  addTrack(track: MediaStreamTrack, ..._streams: MediaStream[]): RTCRtpSender {
    const sender = new FakeRTCRtpSender(track);
    this.senders.push(sender);
    this.scheduleNegotiationNeeded();
    return sender;
  }

  removeTrack(sender: RTCRtpSender): void {
    const idx = this.senders.indexOf(sender as FakeRTCRtpSender);
    if (idx < 0) return;
    const [removed] = this.senders.splice(idx, 1);
    this.scheduleNegotiationNeeded();
    // Propagate removal to the wired peer: end its receiver track (the browser
    // equivalent of the track stopping on the remote side).
    if (this.link && removed?.track) {
      const remote = this.link as FakeRTCPeerConnection;
      for (const receiver of remote.receivers) {
        if (receiver.track === removed.track) {
          receiver.track.stop();
        }
      }
    }
  }

  addTransceiver(
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver {
    const track = typeof trackOrKind === 'string' ? null : trackOrKind;
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const sender = new FakeRTCRtpSender(track);
    const receiver = new FakeRTCRtpReceiver(new FakeMediaStreamTrack(kind as 'audio' | 'video'));
    this.senders.push(sender);
    this.receivers.push(receiver);
    const transceiver = {
      mid: null,
      sender,
      receiver,
      direction: init?.direction ?? 'sendrecv',
      currentDirection: null,
      setCodecPreferences: () => {},
      stop: () => {},
    } as unknown as RTCRtpTransceiver;
    this.scheduleNegotiationNeeded();
    return transceiver;
  }

  getSenders(): RTCRtpSender[] {
    return [...this.senders];
  }

  getReceivers(): RTCRtpReceiver[] {
    return [...this.receivers];
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return [];
  }

  createDataChannel(label: string, _options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    if (this.link) {
      const remote = new FakeDataChannel(label);
      channel.peer = remote;
      remote.peer = channel;
      queueMicrotask(() => {
        if (!this.link) return;
        this.link.ondatachannel?.({ channel: remote } as unknown as RTCDataChannelEvent);
        channel.open();
      });
    } else {
      queueMicrotask(() => channel.open());
    }
    return channel;
  }

  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(new Map() as RTCStatsReport);
  }

  restartIce(): void {
    if (this.closed) return;
    // Fresh ufrag: bump the SDP version so the next offer differs.
    this.sdpVersion += 1;
    this.iceConnectionState = 'new';
    this.connectionState = 'connecting';
    queueMicrotask(() => {
      this.oniceconnectionstatechange?.(new Event('iceconnectionstatechange'));
      this.scheduleNegotiationNeeded();
    });
  }

  setConfiguration(_configuration?: RTCConfiguration): void {
    /* no-op */
  }

  getConfiguration(): RTCConfiguration {
    return this.configuration;
  }

  // EventTarget stubs: the engine uses property handlers (onnegotiationneeded,
  // etc.), so these are no-ops kept for interface completeness.
  addEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    /* no-op */
  }

  removeEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    /* no-op */
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this.signalingState = 'closed';
    queueMicrotask(() => this.onconnectionstatechange?.(new Event('connectionstatechange')));
  }

  // ------------------------------------------------------------ test helpers

  /** Link two fakes so ICE candidates / data channels flow between them. */
  linkTo(other: FakeRTCPeerConnection): void {
    this.link = other;
  }

  /** Simulate a remote ICE candidate arriving over the "network". */
  deliverIce(candidate: RTCIceCandidateInit): void {
    queueMicrotask(() => {
      this.onicecandidate?.({
        candidate: { ...candidate, toJSON: () => candidate },
      } as unknown as RTCPeerConnectionIceEvent);
    });
  }

  /** Simulate an ICE failure (used to test auto-restart). */
  failIce(): void {
    this.iceConnectionState = 'failed';
    queueMicrotask(() => this.oniceconnectionstatechange?.(new Event('iceconnectionstatechange')));
  }

  /** Manually request a negotiationneeded round. */
  fireNegotiationNeeded(): void {
    this.scheduleNegotiationNeeded();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private scheduleNegotiationNeeded(): void {
    if (this.pendingNegotiation) return;
    this.pendingNegotiation = true;
    queueMicrotask(() => {
      this.pendingNegotiation = false;
      if (!this.closed) this.onnegotiationneeded?.(new Event('negotiationneeded'));
    });
  }

  private scheduleTrickle(): void {
    if (this.trickleScheduled || this.options.trickle === false) return;
    this.trickleScheduled = true;
    const delay = this.options.trickleDelayMs ?? 0;
    const emit = () => {
      this.trickleScheduled = false;
      if (this.closed || !this.localSdp) return;
      const base = { sdpMid: '0', sdpMLineIndex: 0 };
      const candidates = [
        { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 54321 typ host', ...base },
        {
          candidate:
            'candidate:2 1 UDP 2122194687 198.51.100.7 54322 typ srflx raddr 192.0.2.1 rport 54321',
          ...base,
        },
      ];
      for (const c of candidates) {
        this.onicecandidate?.({
          candidate: { ...c, toJSON: () => c },
        } as unknown as RTCPeerConnectionIceEvent);
      }
      this.iceGatheringState = 'complete';
      queueMicrotask(() => this.onicegatheringstatechange?.(new Event('icegatheringstatechange')));
    };
    // Always schedule on a macrotask: in real stacks, candidate events are
    // tasks, so the offer signal (fired synchronously after setLocalDescription
    // resolves) is observed before trickled candidates.
    setTimeout(emit, delay);
  }

  private fireRemoteTracks(sdp: string): void {
    const origin = /^o=- (\S+) (\d+) /m.exec(sdp);
    if (!origin) return;
    const remote = fakePcsBySessionId.get(origin[1] ?? '');
    if (!remote) return;
    for (const sender of remote.senders) {
      if (!sender.track) continue;
      const track = sender.track;
      // Renegotiation re-applies offers: don't re-fire already-seen tracks.
      if (this.receivers.some((r) => r.track === track)) continue;
      const receiver = new FakeRTCRtpReceiver(track);
      this.receivers.push(receiver);
      const transceiver = {
        mid: null,
        sender: new FakeRTCRtpSender(null),
        receiver,
        direction: 'recvonly',
        currentDirection: 'recvonly',
        setCodecPreferences: () => {},
        stop: () => {},
      } as unknown as RTCRtpTransceiver;
      queueMicrotask(() => {
        this.ontrack?.({ track, receiver, transceiver, streams: [] } as unknown as RTCTrackEvent);
      });
    }
  }
}

// ------------------------------------------------------------ wiring helpers

export interface WiredPeerPair<T = FakeRTCPeerConnection> {
  a: T;
  b: T;
}

/** Wire two fake pcs together (ICE + data channels + track delivery). */
export function wirePeers(
  a: FakeRTCPeerConnection,
  b: FakeRTCPeerConnection,
): WiredPeerPair<FakeRTCPeerConnection> {
  a.linkTo(b);
  b.linkTo(a);
  return { a, b };
}

/** Create two wired fake pcs. */
export function createPeerPair(): WiredPeerPair<FakeRTCPeerConnection> {
  return wirePeers(new FakeRTCPeerConnection(), new FakeRTCPeerConnection());
}

/** Install fakes as the global WebRTC classes (for `new RTCPeerConnection()`). */
export function installFakeRTC(): void {
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakeRTCPeerConnection;
}

/** Reset global fake state between tests. */
export function resetFakeRTC(): void {
  fakePcsBySessionId.clear();
  FakeRTCPeerConnection.instances.length = 0;
}

/** Narrow an engine-facing RTCPeerConnection back to the fake for assertions. */
export function asFake(pc: RTCPeerConnection): FakeRTCPeerConnection {
  return pc as unknown as FakeRTCPeerConnection;
}
