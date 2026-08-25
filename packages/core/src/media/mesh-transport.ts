import type { Envelope } from '@mbsks/openrtc-protocol';
import type { TrackPublication } from '../participants.ts';
import { LocalParticipant, RemoteParticipant } from '../participants.ts';
import { PeerConnectionManager } from '../peer-connection-manager.ts';
import type { PeerSignal } from '../peer-connection-manager.ts';
import { DataChannelBus } from '../data-channel-bus.ts';
import type { OrderedMessageBuffer } from '../ordering.ts';
import type { SignalingTransport } from '../transport.ts';
import type {
  ExtendedPublishOptions,
  MediaSubscribeOptions,
  MediaTrackEvent,
  MediaTransport,
  PeerConnectionStateEvent,
  TrackSubscription,
} from './media-transport.ts';
import type { RoomQualityController } from '../room-quality.ts';
import type { ProcessorChain } from './processor.ts';

export interface MeshMediaTransportOptions {
  roomId: string;
  selfId: string;
  sessionId: string;
  transport: SignalingTransport;
  local: LocalParticipant;
  remotes: Map<string, RemoteParticipant>;
  orderBuffer: OrderedMessageBuffer;
  peerFactory?: (participantId: string) => RTCPeerConnection;
  iceServers?: RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>);
  polite?: boolean | ((selfId: string, remoteId: string) => boolean);
  autoRestartIce?: boolean;
  dataChannelName?: string;
  getNextSeq: () => number;
  quality: RoomQualityController;
  processorChain?: ProcessorChain;
  pendingIceServers?: RTCIceServer[] | null;
  resolveIceServers: () => Promise<RTCIceServer[]>;
  e2eeSetupPeer?: (pc: RTCPeerConnection) => Promise<void>;
  debug: (message: string, data?: unknown) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  manager: PeerConnectionManager;
  bus: DataChannelBus;
}

export class MeshMediaTransport implements MediaTransport {
  readonly kind = 'mesh' as const;
  private readonly opts: MeshMediaTransportOptions;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly trackCbs = new Set<(e: MediaTrackEvent) => void>();
  private readonly connCbs = new Set<(e: PeerConnectionStateEvent) => void>();
  private closed = false;

  constructor(opts: MeshMediaTransportOptions) {
    this.opts = opts;
  }

  async publish(track: MediaStreamTrack, options: ExtendedPublishOptions = {}): Promise<TrackPublication> {
    if (this.closed) throw new Error('Room is closed');
    const processed = this.opts.processorChain?.process(track) ?? track;
    const publication: TrackPublication = {
      id: (processed as unknown as { id?: string }).id || (track as unknown as { id?: string }).id || randomId(),
      kind: processed.kind === 'audio' ? 'audio' : 'video',
      source: options.source ?? (processed.kind === 'audio' ? 'microphone' : 'camera'),
      participantId: this.opts.local.id,
      isLocal: true,
      track: processed,
      muted: false,
      metadata: options.metadata,
    };
    for (const participantId of this.opts.remotes.keys()) {
      const entry = await this.ensurePeer(participantId);
      entry.pc.addTrack(processed as unknown as MediaStreamTrack);
      this.applyPublishOptions(entry, publication, options);
      await entry.manager.negotiate('track-added');
    }
    return publication;
  }

  private applyPublishOptions(entry: PeerEntry, pub: TrackPublication, opts: ExtendedPublishOptions): void {
    const sender = entry.pc.getSenders().find((s) => s.track === pub.track);
    if (!sender) return;
    try {
      if (opts.simulcast) {
        const encodings =
          typeof opts.simulcast === 'object' && Array.isArray((opts.simulcast as { encodings?: unknown[] }).encodings)
            ? (opts.simulcast as { encodings: RTCRtpEncodingParameters[] }).encodings
            : undefined;
        if (encodings?.length) {
          const params = sender.getParameters();
          sender.setParameters({ ...params, encodings }).catch(() => {});
        }
      }
      if (opts.svc?.scalabilityMode) {
        const params = sender.getParameters();
        const enc = params.encodings?.[0];
        if (enc) {
          (enc as unknown as Record<string, unknown>).scalabilityMode = opts.svc.scalabilityMode;
          sender.setParameters(params).catch(() => {});
        }
      }
      if (opts.codecPreferences?.length) {
        const transceivers = entry.pc.getTransceivers?.() ?? [];
        for (const t of transceivers) {
          if (t.sender === sender && typeof (t as unknown as { setCodecPreferences?: unknown }).setCodecPreferences === 'function') {
            try {
              const caps =
                typeof RTCRtpSender !== 'undefined' &&
                typeof (RTCRtpSender as unknown as { getCapabilities?: unknown }).getCapabilities === 'function'
                  ? ((RTCRtpSender as unknown as { getCapabilities: (k: string) => { codecs: CodecCapability[] } }).getCapabilities(pub.kind))
                  : null;
              if (caps?.codecs?.length) {
                const ranked = rankCodecs(caps.codecs, opts.codecPreferences);
                (t as unknown as { setCodecPreferences: (c: CodecCapability[]) => void }).setCodecPreferences(ranked);
              }
            } catch { /* Safari H264 fallback */ }
            break;
          }
        }
      }
    } catch { /* best effort */ }
  }

  async unpublish(pub: TrackPublication): Promise<void> {
    const track = pub.track as unknown as MediaStreamTrack | null;
    if (!track) return;
    for (const entry of this.peers.values()) {
      let sender = entry.pc.getSenders().find((s) => s.track === track);
      if (!sender) {
        sender = entry.pc.getSenders().find((s) => (s.track as unknown as { id?: string })?.id === (track as unknown as { id?: string }).id);
      }
      if (sender) entry.pc.removeTrack(sender);
      try {
        await entry.manager.negotiate('track-removed');
      } catch (e) {
        if (String(e).includes('have-local-offer')) {
          await new Promise((r) => setTimeout(r, 60));
          try { await entry.manager.negotiate('track-removed'); } catch { /* best effort */ }
        } else {
          this.opts.debug('mesh:unpublish-negotiate-failed', e);
        }
      }
    }
  }

  async subscribe(participantId: string, options?: MediaSubscribeOptions): Promise<TrackSubscription> {
    const participant = this.opts.remotes.get(participantId);
    if (!participant) throw new Error(`Room: unknown participant '${participantId}'`);
    const kind = options?.kind;
    const matching = () => participant.publications.filter((p) => !kind || p.kind === kind);
    return {
      participantId,
      get publication(): TrackPublication | undefined { return matching()[0]; },
      setEnabled(enabled: boolean): void {
        for (const p of matching()) if (p.track) p.track.enabled = enabled;
      },
      close(): void { /* mesh: no decoder resources */ },
    };
  }

  async setPreferredLayers(_trackId: string, _layer: string): Promise<void> { /* mesh: no-op */ }
  async requestKeyframe(_trackId: string): Promise<void> { /* mesh: no-op */ }

  getSenders(): RTCRtpSender[] {
    const out: RTCRtpSender[] = [];
    for (const e of this.peers.values()) out.push(...e.manager.getSenders());
    return out;
  }

  getPeerConnections(): RTCPeerConnection[] {
    return [...this.peers.values()].map((e) => e.pc);
  }

  getDataChannelBus(participantId: string): DataChannelBus | undefined {
    return this.peers.get(participantId)?.bus;
  }

  onTrack(cb: (e: MediaTrackEvent) => void): () => void {
    this.trackCbs.add(cb);
    return () => this.trackCbs.delete(cb);
  }

  onConnectionState(cb: (e: PeerConnectionStateEvent) => void): () => void {
    this.connCbs.add(cb);
    return () => this.connCbs.delete(cb);
  }

  async restartIce(participantId?: string): Promise<void> {
    const targets = participantId ? [participantId] : [...this.peers.keys()];
    for (const id of targets) {
      const e = this.peers.get(id);
      if (e) await e.manager.restartIce();
    }
  }

  private async emitSignalTo(participantId: string, signal: PeerSignal): Promise<void> {
    const base = {
      roomId: this.opts.roomId,
      senderId: this.opts.local.id,
      sessionId: this.opts.sessionId,
      ts: Date.now(),
      seq: this.opts.getNextSeq(),
      targetSenderId: participantId,
    };
    const env: Envelope =
      signal.type === 'ice'
        ? { v: 1, type: 'ice', ...base, payload: signal.payload as never }
        : { v: 1, type: (signal.type as 'offer' | 'answer'), ...base, payload: signal.payload as never };
    await this.opts.transport.emit(env);
  }

  async handleEnvelope(envelope: Envelope): Promise<boolean> {
    switch (envelope.type) {
      case 'offer':
      case 'answer': {
        const payload = envelope.payload as { sdp?: string } | undefined;
        if (!payload || typeof payload.sdp !== 'string') {
          this.opts.debug('signal:missing-sdp', envelope.type);
          return true;
        }
        const entry = await this.ensurePeer(envelope.senderId);
        await entry.manager.handleSignal({ type: envelope.type, payload: { sdp: payload.sdp, label: (payload as { label?: string }).label } as never });
        return true;
      }
      case 'ice': {
        const payload = envelope.payload as { candidate?: string } | undefined;
        if (!payload || typeof payload.candidate !== 'string') return true;
        const entry = await this.ensurePeer(envelope.senderId);
        await entry.manager.handleSignal({
          type: 'ice',
          payload: {
            candidate: (payload as { candidate: string }).candidate,
            sdpMid: (payload as { sdpMid?: string | null }).sdpMid ?? null,
            sdpMLineIndex: (payload as { sdpMLineIndex?: number | null }).sdpMLineIndex ?? null,
          } as never,
        });
        return true;
      }
      case 'sfu':
        return false;
      default:
        return false;
    }
  }

  async handleRemoteJoin(senderId: string): Promise<void> {
    if (this.opts.local.publications.length === 0) return;
    const entry = await this.ensurePeer(senderId);
    await entry.manager.negotiate('remote-joined');
  }

  handleRemoteLeave(senderId: string): void {
    const e = this.peers.get(senderId);
    if (!e) return;
    e.bus.close();
    e.manager.close();
    this.peers.delete(senderId);
  }

  async ensurePeer(participantId: string): Promise<PeerEntry> {
    const existing = this.peers.get(participantId);
    if (existing) return existing;
    if (this.closed) throw new Error('Room is closed');
    if (!this.opts.remotes.has(participantId)) {
      const shell = new RemoteParticipant({ id: participantId });
      this.opts.remotes.set(participantId, shell);
      this.opts.emit('participant-joined', shell);
    }
    let iceServersResolved: RTCIceServer[] = [];
    if (!this.opts.peerFactory) iceServersResolved = await this.opts.resolveIceServers();
    const pc = this.opts.peerFactory
      ? this.opts.peerFactory(participantId)
      : new RTCPeerConnection({ iceServers: iceServersResolved });
    const polite =
      typeof this.opts.polite === 'function'
        ? this.opts.polite(this.opts.local.id, participantId)
        : typeof this.opts.polite === 'boolean'
          ? this.opts.polite
          : this.opts.local.id < participantId;
    const bus = new DataChannelBus(pc, {
      name: this.opts.dataChannelName ?? 'vidcall',
      wireOnDataChannel: false,
      debug: this.opts.debug,
    });
    const manager = new PeerConnectionManager({
      pc,
      polite,
      autoRestartIce: this.opts.autoRestartIce ?? true,
      debug: this.opts.debug,
      onSignal: (signal) => { this.emitSignalTo(participantId, signal).catch((e) => this.opts.emit('error', e instanceof Error ? e : new Error(String(e)))); },
      onConnectionState: (state) => {
        const p = this.opts.remotes.get(participantId);
        if (p) p.connectionState = state;
        this.opts.emit('connection-state', { participantId, state });
        for (const cb of this.connCbs) cb({ participantId, state });
      },
      onIceConnectionState: (state) => this.opts.emit('ice-connection-state', { participantId, state }),
      onDataChannel: (ch) => bus.adoptRemote(ch),
      onTrack: (event) => this.handleRemoteTrack(participantId, event),
      onError: (err) => this.opts.emit('error', err),
    });
    bus.on('reaction', (payload) => this.opts.emit('reaction', { ...payload, senderId: participantId, participantId }));
    bus.on('chat', (payload) => this.opts.emit('chat', { ...payload, senderId: participantId, participantId }));
    bus.on('control', (m) => this.opts.debug('datachannel:control', { participantId, message: m }));
    for (const pub of this.opts.local.publications) {
      if (pub.track) {
        pc.addTrack(pub.track as unknown as MediaStreamTrack);
        await this.opts.quality.attachTrack(pub.track as unknown as MediaStreamTrack);
      }
    }
    if (this.opts.e2eeSetupPeer) {
      try { await this.opts.e2eeSetupPeer(pc); } catch (err) { this.opts.debug('e2ee:setup-failed', err); }
    }
    const entry: PeerEntry = { pc, manager, bus };
    this.peers.set(participantId, entry);
    return entry;
  }

  private handleRemoteTrack(participantId: string, event: RTCTrackEvent): void {
    const participant = this.opts.remotes.get(participantId);
    if (!participant) return;
    const track = event.track;
    const kind = track.kind === 'audio' ? 'audio' : 'video';
    const id: string = (track as unknown as { id?: string }).id || randomId();
    let pub = participant.getPublication(id);
    if (pub) return;
    pub = { id, kind, source: kind === 'video' ? 'camera' : 'microphone', participantId, isLocal: false, track: track as unknown as MediaStreamTrack, muted: false };
    participant.addPublication(pub as unknown as TrackPublication);
    const evt: MediaTrackEvent = { participantId, track: track as unknown as MediaStreamTrack, kind, publicationId: id };
    for (const cb of this.trackCbs) cb(evt);
    this.opts.emit('track', { participant, publication: pub, track });
    (track as unknown as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.('ended', () => {
      const removed = participant.removePublication(id);
      if (removed) this.opts.emit('track-unpublished', { participant, publication: removed, track });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const e of this.peers.values()) { e.bus.close(); e.manager.close(); }
    this.peers.clear();
  }
}

type CodecCapability = { mimeType: string };
function rankCodecs(codecs: CodecCapability[], prefs: string[]): CodecCapability[] {
  const norm = (s: string) => s.toLowerCase();
  const prefN = prefs.map(norm);
  return [...codecs].sort((a, b) => {
    const ai = prefN.indexOf(norm(a.mimeType.split('/')[1] ?? a.mimeType));
    const bi = prefN.indexOf(norm(b.mimeType.split('/')[1] ?? b.mimeType));
    const av = ai === -1 ? 999 : ai;
    const bv = bi === -1 ? 999 : bi;
    return av - bv;
  });
}
function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
