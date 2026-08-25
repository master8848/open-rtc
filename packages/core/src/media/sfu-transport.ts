import type { Envelope, SfuKind } from '@mbsks/openrtc-protocol';
import type { TrackPublication } from '../participants.ts';
import type {
  ExtendedPublishOptions,
  MediaSubscribeOptions,
  MediaTrackEvent,
  MediaTransport,
  PeerConnectionStateEvent,
  TrackSubscription,
} from './media-transport.ts';
import type { ProcessorChain } from './processor.ts';

export interface SfuMediaTransportOptions {
  roomId: string;
  selfId: string;
  sessionId: string;
  gateway: SfuGatewayLike;
  transport: SignalingTransportLike;
  processorChain?: ProcessorChain;
  sfuParticipantId?: string;
  peerFactory?: (participantId: string) => RTCPeerConnection;
  iceServers?: RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>);
  getNextSeq: () => number;
  debug: (message: string, data?: unknown) => void;
  emit: (event: string, ...args: unknown[]) => void;
  localPublications: () => TrackPublication[];
  addRemoteTrack: (participantId: string, track: MediaStreamTrack, kind: 'audio' | 'video') => void;
}

export interface SfuGatewayLike {
  join(roomId: string, participantId: string): Promise<SfuSessionLike>;
  onTrack(cb: (e: { participantId: string; trackId: string; kind: SfuKind; direction: string; publicationId: string; layer?: string; roomId: string }) => void): () => void;
  close?(roomId?: string): Promise<void>;
}
export interface SfuSessionLike {
  publishTrack(trackId: string, kind: SfuKind, opts?: unknown): Promise<void>;
  subscribe(participantId: string, opts?: unknown): Promise<void>;
  setPreferredLayers(trackId: string, layer: string): Promise<void>;
  requestKeyframe(trackId: string): Promise<void>;
  handleOffer(offer: { sdp: string }): Promise<void>;
  handleAnswer(answer: { sdp: string }): Promise<void>;
  addIceCandidate(c: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }): Promise<void>;
  leave(): Promise<void>;
}
export interface SignalingTransportLike { emit(envelope: Envelope): Promise<void>; }

export class SfuMediaTransport implements MediaTransport {
  readonly kind = 'sfu' as const;
  private readonly opts: SfuMediaTransportOptions;
  private readonly sfuParticipantId: string;
  private pc: RTCPeerConnection | null = null;
  private session: SfuSessionLike | null = null;
  private readonly trackCbs = new Set<(e: MediaTrackEvent) => void>();
  private readonly connCbs = new Set<(e: PeerConnectionStateEvent) => void>();
  private unsubGateway: (() => void) | null = null;
  private closed = false;
  private readonly pendingPublishes: Array<{ track: MediaStreamTrack; opts: ExtendedPublishOptions }> = [];
  private negotiating = false;

  constructor(opts: SfuMediaTransportOptions) {
    this.opts = opts;
    this.sfuParticipantId = opts.sfuParticipantId ?? 'sfu';
  }

  async init(): Promise<void> {
    this.session = await this.opts.gateway.join(this.opts.roomId, this.opts.selfId);
    this.pc = this.createPc();
    this.unsubGateway = this.opts.gateway.onTrack(() => {});
    for (const pub of this.opts.localPublications()) {
      if (pub.track) await this.publish(pub.track as unknown as MediaStreamTrack, { source: pub.source, metadata: pub.metadata });
    }
    for (const { track, opts } of this.pendingPublishes.splice(0)) await this.publish(track, opts);
  }

  private createPc(): RTCPeerConnection {
    const pc = this.opts.peerFactory ? this.opts.peerFactory(this.sfuParticipantId) : new RTCPeerConnection({ iceServers: [] });
    pc.onnegotiationneeded = () => { this.negotiate().catch((e) => this.opts.debug('sfu:negotiate-failed', e)); };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const c = ev.candidate;
      this.opts.transport.emit({
        v: 1, type: 'ice', roomId: this.opts.roomId, senderId: this.opts.selfId, sessionId: this.opts.sessionId, ts: Date.now(), seq: this.opts.getNextSeq(), targetSenderId: this.sfuParticipantId,
        payload: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null },
      } as unknown as Envelope).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      for (const cb of this.connCbs) cb({ participantId: this.sfuParticipantId, state: pc.connectionState });
      this.opts.emit('connection-state', { participantId: this.sfuParticipantId, state: pc.connectionState });
    };
    pc.ontrack = (event) => {
      const track = event.track;
      const kind = track.kind === 'audio' ? 'audio' : 'video';
      this.opts.addRemoteTrack(this.sfuParticipantId, track as unknown as MediaStreamTrack, kind);
      for (const cb of this.trackCbs) cb({ participantId: this.sfuParticipantId, track: track as unknown as MediaStreamTrack, kind });
    };
    return pc;
  }

  private async negotiate(): Promise<void> {
    if (!this.pc || this.negotiating) return;
    this.negotiating = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdp = this.pc.localDescription?.sdp ?? offer.sdp ?? '';
      await this.opts.transport.emit({
        v: 1, type: 'offer', roomId: this.opts.roomId, senderId: this.opts.selfId, sessionId: this.opts.sessionId, ts: Date.now(), seq: this.opts.getNextSeq(), targetSenderId: this.sfuParticipantId,
        payload: { sdp },
      } as unknown as Envelope);
      if (this.session) await this.session.handleOffer({ sdp });
    } finally { this.negotiating = false; }
  }

  async publish(track: MediaStreamTrack, opts: ExtendedPublishOptions = {}): Promise<TrackPublication> {
    if (this.closed) throw new Error('Room is closed');
    if (!this.session || !this.pc) {
      this.pendingPublishes.push({ track, opts });
      return { id: (track as unknown as { id?: string }).id || randomId(), kind: track.kind === 'audio' ? 'audio' : 'video', source: opts.source ?? 'camera', participantId: this.opts.selfId, isLocal: true, track, muted: false, metadata: opts.metadata };
    }
    const processed = this.opts.processorChain?.process(track) ?? track;
    const trackId = (processed as unknown as { id?: string }).id || (processed as unknown as MediaStreamTrack).id || randomId();
    const kind: SfuKind = processed.kind === 'audio' ? 'audio' : 'video';
    const simulcast = typeof opts.simulcast === 'boolean' ? opts.simulcast : !!(opts.simulcast as { encodings?: unknown[] } | null)?.encodings?.length || (opts.simulcast as { layers?: number } | null)?.layers !== undefined;
    const sender = this.pc.addTrack(processed as unknown as MediaStreamTrack);
    try {
      if (opts.svc?.scalabilityMode) {
        const p = sender.getParameters();
        if (p.encodings?.[0]) (p.encodings[0] as unknown as Record<string, unknown>).scalabilityMode = opts.svc.scalabilityMode;
        await sender.setParameters(p);
      }
      if (opts.codecPreferences?.length) {
        for (const t of this.pc.getTransceivers?.() ?? []) {
          if (t.sender === sender && typeof (t as unknown as { setCodecPreferences?: unknown }).setCodecPreferences === 'function') {
            try {
              const caps = typeof RTCRtpSender !== 'undefined' && typeof (RTCRtpSender as unknown as { getCapabilities?: unknown }).getCapabilities === 'function'
                ? ((RTCRtpSender as unknown as { getCapabilities: (k: string) => { codecs: CodecCapability[] } }).getCapabilities(kind))
                : null;
              if (caps?.codecs?.length) {
                const ranked = rankCodecs(caps.codecs, opts.codecPreferences);
                (t as unknown as { setCodecPreferences: (c: CodecCapability[]) => void }).setCodecPreferences(ranked);
              }
            } catch { /* Safari */ }
            break;
          }
        }
      }
      if (simulcast) {
        const p = sender.getParameters();
        if (!p.encodings?.length || p.encodings.length < 2) {
          const enc = typeof opts.simulcast === 'object' && opts.simulcast !== null ? (opts.simulcast as { encodings?: RTCRtpEncodingParameters[] }).encodings : undefined;
          if (enc?.length) await sender.setParameters({ ...p, encodings: enc as RTCRtpEncodingParameters[] });
        }
      }
    } catch { /* best effort */ }
    await this.session.publishTrack(trackId, kind, simulcast ? { simulcast: true } : undefined);
    await this.negotiate();
    return { id: trackId, kind: processed.kind === 'audio' ? 'audio' : 'video', source: opts.source ?? 'camera', participantId: this.opts.selfId, isLocal: true, track: processed as unknown as MediaStreamTrack, muted: false, metadata: opts.metadata };
  }

  async unpublish(pub: TrackPublication): Promise<void> {
    if (!this.pc || !this.session) return;
    const sender = this.pc.getSenders().find((s) => s.track === pub.track);
    if (sender) this.pc.removeTrack(sender);
    await this.negotiate();
  }

  async subscribe(participantId: string, _opts?: MediaSubscribeOptions): Promise<TrackSubscription> {
    if (!this.session) throw new Error('SFU session not ready');
    await this.session.subscribe(participantId);
    await this.negotiate();
    return { participantId, get publication(): TrackPublication | undefined { return undefined; }, setEnabled(): void {}, close(): void {} };
  }

  async setPreferredLayers(trackId: string, layer: string): Promise<void> {
    if (!this.session) throw new Error('SFU session not ready');
    await this.session.setPreferredLayers(trackId, layer);
  }
  async requestKeyframe(trackId: string): Promise<void> {
    if (!this.session) throw new Error('SFU session not ready');
    await this.session.requestKeyframe(trackId);
  }

  getSenders(): RTCRtpSender[] { return this.pc?.getSenders() ?? []; }
  getPeerConnections(): RTCPeerConnection[] { return this.pc ? [this.pc] : []; }
  getDataChannelBus(): undefined { return undefined; }
  onTrack(cb: (e: MediaTrackEvent) => void): () => void { this.trackCbs.add(cb); return () => this.trackCbs.delete(cb); }
  onConnectionState(cb: (e: PeerConnectionStateEvent) => void): () => void { this.connCbs.add(cb); return () => this.connCbs.delete(cb); }

  async restartIce(): Promise<void> {
    if (!this.pc) return;
    if (typeof this.pc.restartIce === 'function') this.pc.restartIce();
    await new Promise((r) => setTimeout(r, 0));
    await this.negotiate();
  }

  async handleEnvelope(envelope: Envelope): Promise<boolean> {
    if (envelope.targetSenderId && envelope.targetSenderId !== this.opts.selfId) return false;
    if (!this.session || !this.pc) return false;
    if (envelope.type === 'offer' && envelope.targetSenderId === this.opts.selfId) {
      const sdp = (envelope.payload as { sdp?: string } | undefined)?.sdp; if (!sdp) return true;
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const answerSdp = this.pc.localDescription?.sdp ?? answer.sdp ?? '';
      await this.opts.transport.emit({ v: 1, type: 'answer', roomId: this.opts.roomId, senderId: this.opts.selfId, sessionId: this.opts.sessionId, ts: Date.now(), seq: this.opts.getNextSeq(), targetSenderId: envelope.senderId, payload: { sdp: answerSdp } } as unknown as Envelope);
      return true;
    }
    if (envelope.type === 'answer' && envelope.senderId === this.sfuParticipantId) {
      const sdp = (envelope.payload as { sdp?: string } | undefined)?.sdp; if (!sdp) return true;
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      await this.session.handleAnswer({ sdp });
      return true;
    }
    if (envelope.type === 'ice' && envelope.senderId === this.sfuParticipantId) {
      const c = envelope.payload as { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | undefined;
      if (c?.candidate) {
        try { await this.pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid ?? undefined, sdpMLineIndex: c.sdpMLineIndex ?? undefined }); } catch { /* ignore */ }
        await this.session.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
      }
      return true;
    }
    return false;
  }

  async handleSfuEnvelope(envelope: Envelope): Promise<boolean> {
    if (!this.session) return false;
    const p = envelope.payload as { action?: string; trackId?: string; kind?: string; senderId?: string; layer?: string } | undefined;
    if (!p?.action) return false;
    try {
      switch (p.action) {
        case 'publish': if (p.trackId && p.kind) await this.session.publishTrack(p.trackId, p.kind as SfuKind); break;
        case 'subscribe': if (p.senderId) await this.session.subscribe(p.senderId); break;
        case 'layer-change': if (p.trackId && p.layer) await this.session.setPreferredLayers(p.trackId, p.layer); break;
        case 'keyframe-request': if (p.trackId) await this.session.requestKeyframe(p.trackId); break;
        case 'leave': await this.session.leave(); break;
      }
    } catch (e) { this.opts.debug('sfu:envelope-failed', e); }
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubGateway?.();
    try { await this.session?.leave(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null; this.session = null;
  }

  get __session(): SfuSessionLike | null { return this.session; }
  get __pc(): RTCPeerConnection | null { return this.pc; }
}

type CodecCapability = { mimeType: string };
function rankCodecs(codecs: CodecCapability[], prefs: string[]): CodecCapability[] {
  const norm = (s: string) => s.toLowerCase();
  const prefN = prefs.map(norm);
  return [...codecs].sort((a, b) => {
    const ai = prefN.indexOf(norm(a.mimeType.split('/')[1] ?? a.mimeType));
    const bi = prefN.indexOf(norm(b.mimeType.split('/')[1] ?? b.mimeType));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}
function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
