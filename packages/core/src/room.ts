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
} from '@vidcall/protocol';
import { DataChannelBus } from './data-channel-bus.ts';
import { TypedEmitter } from './events.ts';
import { OrderedMessageBuffer } from './ordering.ts';
import { LocalParticipant, RemoteParticipant } from './participants.ts';
import type { TrackPublication } from './participants.ts';
import { PeerConnectionManager } from './peer-connection-manager.ts';
import type { PeerSignal } from './peer-connection-manager.ts';
import type { ParticipantInfo, SignalingTransport } from './transport.ts';

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

export interface RoomReactionEvent extends ReactionPayload {
  senderId: string;
  participantId: string;
}

export interface RoomChatEvent extends ChatPayload {
  senderId: string;
  participantId: string;
}

export interface RoomScreenShareEvent extends ScreenSharePayload {
  senderId: string;
  participantId: string;
}

export interface RoomQualityWarningEvent extends QualityWarningPayload {
  senderId: string;
  participantId: string;
}

export type RoomEventMap = {
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
  'quality-warning': [RoomQualityWarningEvent];
  /** Presence update from the backend presence layer. */
  presence: [ParticipantInfo & { state: PresenceState }];
  error: [Error];
  /** Emitted once after `leave()`/`close()` completes. */
  closed: [];
};

// ------------------------------------------------------------------ config

export interface PublishOptions {
  source?: TrackPublication['source'];
  metadata?: Record<string, unknown>;
}

export interface TrackSubscription {
  participantId: string;
  /** First matching remote publication (undefined until a track arrives). */
  readonly publication: TrackPublication | undefined;
  /** Enable/disable decoding of the subscribed tracks (mesh: track.enabled). */
  setEnabled(enabled: boolean): void;
  close(): void;
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
  transport: SignalingTransport;
  /**
   * RTCPeerConnection factory (default: platform `RTCPeerConnection`).
   * Tests inject fakes here.
   */
  peerFactory?: (participantId: string) => RTCPeerConnection;
  iceServers?: RTCIceServer[];
  /** Politeness rule for perfect negotiation. Default: `selfId < remoteId`. */
  polite?: boolean | ((selfId: string, remoteId: string) => boolean);
  /** Auto-restart ICE when a peer's iceConnectionState turns 'failed'. */
  autoRestartIce?: boolean;
  /** Data channel label (default 'vidcall'). */
  dataChannelName?: string;
  debug?: (message: string, data?: unknown) => void;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  manager: PeerConnectionManager;
  bus: DataChannelBus;
}

// ------------------------------------------------------------------- room

export class Room extends TypedEmitter<RoomEventMap> {
  readonly roomId: string;
  readonly local: LocalParticipant;
  readonly sessionId: string;
  private readonly config: RoomConfig;
  private readonly transport: SignalingTransport;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly remoteById = new Map<string, RemoteParticipant>();
  private readonly buffer = new OrderedMessageBuffer();
  private readonly unsubscribers: (() => void)[] = [];
  private seq = 0;
  private joined = false;
  private closed = false;

  constructor(config: RoomConfig) {
    super();
    this.config = config;
    this.roomId = config.roomId;
    this.transport = config.transport;
    this.sessionId = config.sessionId ?? randomId();
    this.local = new LocalParticipant({
      id: config.selfId,
      displayName: config.displayName,
      metadata: config.metadata,
      deviceProfile: config.deviceProfile,
      capabilities: config.capabilities,
    });
  }

  // -------------------------------------------------------------- join/leave

  /** Join the room: subscribe to signaling + presence, announce ourselves. */
  async join(): Promise<this> {
    if (this.joined) return this;
    if (this.closed) throw new Error('Room is closed');
    const info: ParticipantInfo = {
      id: this.local.id,
      displayName: this.local.displayName,
      metadata: this.local.metadata,
    };
    await this.transport.join(this.roomId, info);
    this.unsubscribers.push(
      this.transport.onMessage((envelope) => {
        this.handleEnvelope(envelope).catch((err) => this.reportError(err));
      }),
      this.transport.onPresence((presence) => this.handlePresence(presence)),
    );
    await this.transport.setPresence('online', this.local.metadata);
    await this.emitEnvelope('join', {
      displayName: this.local.displayName,
      metadata: this.local.metadata,
      deviceProfile: this.local.deviceProfile,
      capabilities: this.local.capabilities,
    });
    this.joined = true;
    return this;
  }

  /** Leave the room: announce, close all peer connections, unsubscribe. */
  async leave(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.transport.setPresence('offline', undefined).catch(() => {});
      await this.emitEnvelope('leave', { reason });
    } catch (err) {
      this.debug('leave:announce-failed', err);
    }
    for (const entry of this.peers.values()) {
      entry.bus.close();
      entry.manager.close();
    }
    this.peers.clear();
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

  /** Publish a local track to every remote participant (mesh: renegotiation). */
  async publish(track: MediaStreamTrack, options: PublishOptions = {}): Promise<TrackPublication> {
    if (this.closed) throw new Error('Room is closed');
    const publication: TrackPublication = {
      id: track.id || randomId(),
      kind: track.kind === 'audio' ? 'audio' : 'video',
      source: options.source ?? (track.kind === 'audio' ? 'microphone' : 'camera'),
      participantId: this.local.id,
      isLocal: true,
      track,
      muted: false,
      metadata: options.metadata,
    };
    this.local.addPublication(publication);
    for (const participantId of this.remoteById.keys()) {
      const entry = await this.ensurePeer(participantId);
      entry.pc.addTrack(track);
      await entry.manager.negotiate('track-added');
    }
    return publication;
  }

  /** Stop publishing a local track and renegotiate. */
  async unpublish(publication: TrackPublication): Promise<void> {
    const pub = this.local.removePublication(publication.id);
    if (!pub || !pub.track) return;
    const track = pub.track;
    pub.track = null;
    for (const entry of this.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track === track);
      if (sender) entry.pc.removeTrack(sender);
      await entry.manager.negotiate('track-removed');
    }
  }

  /**
   * Subscribe to a remote participant's media. In mesh mode tracks arrive
   * automatically via `ontrack`; the subscription is a control handle (e.g.
   * to pause decoding of a hidden tile).
   */
  async subscribe(
    participantId: string,
    options: { kind?: 'audio' | 'video' } = {},
  ): Promise<TrackSubscription> {
    const participant = this.remoteById.get(participantId);
    if (!participant) throw new Error(`Room: unknown participant '${participantId}'`);
    const matching = () =>
      participant.publications.filter((p) => !options.kind || p.kind === options.kind);
    return {
      participantId,
      get publication(): TrackPublication | undefined {
        return matching()[0];
      },
      setEnabled(enabled: boolean): void {
        for (const p of matching()) if (p.track) p.track.enabled = enabled;
      },
      close(): void {
        /* mesh: no decoder resources to release */
      },
    };
  }

  // -------------------------------------------------------------- presence

  async setPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    if (metadata !== undefined) this.local.setMetadata(metadata);
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

  // ------------------------------------------------------------- ICE control

  /** Restart ICE for one peer (default: all peers). */
  async restartIce(participantId?: string): Promise<void> {
    const targets = participantId ? [participantId] : [...this.peers.keys()];
    for (const id of targets) {
      const entry = this.peers.get(id);
      if (!entry) continue;
      await entry.manager.restartIce();
    }
  }

  // -------------------------------------------------------------- accessors

  getParticipants(): RemoteParticipant[] {
    return [...this.remoteById.values()];
  }

  getParticipant(id: string): RemoteParticipant | undefined {
    return this.remoteById.get(id);
  }

  getPeerConnection(participantId: string): RTCPeerConnection | undefined {
    return this.peers.get(participantId)?.pc;
  }

  /** The typed data channel for a peer (reactions/chat/control over SCTP). */
  getDataChannelBus(participantId: string): DataChannelBus | undefined {
    return this.peers.get(participantId)?.bus;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ------------------------------------------------------------- internals

  private get debug(): (message: string, data?: unknown) => void {
    return this.config.debug ?? (() => {});
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

  private async emitSignalTo(participantId: string, signal: PeerSignal): Promise<void> {
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
        ? { v: 1, type: 'ice', ...base, payload: signal.payload as IcePayload }
        : { v: 1, type: signal.type, ...base, payload: signal.payload as OfferPayload };
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
      case 'answer': {
        if (!envelope.payload || typeof envelope.payload.sdp !== 'string') {
          this.debug('signal:missing-sdp', envelope.type);
          return;
        }
        const entry = await this.ensurePeer(envelope.senderId);
        await entry.manager.handleSignal({
          type: envelope.type,
          payload: { sdp: envelope.payload.sdp, label: envelope.payload.label },
        });
        break;
      }
      case 'ice': {
        if (!envelope.payload || typeof envelope.payload.candidate !== 'string') return;
        const entry = await this.ensurePeer(envelope.senderId);
        await entry.manager.handleSignal({
          type: 'ice',
          payload: {
            candidate: envelope.payload.candidate,
            sdpMid: envelope.payload.sdpMid ?? null,
            sdpMLineIndex: envelope.payload.sdpMLineIndex ?? null,
          },
        });
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
      case 'ping':
        await this.emitEnvelope('pong', {});
        break;
      case 'pong':
      case 'sfu':
        break;
      case 'error':
        this.reportError(new Error(envelope.payload?.message ?? 'remote error'));
        break;
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
    // If we already have local tracks, open a peer connection and offer.
    if (this.local.publications.length > 0) {
      const entry = await this.ensurePeer(senderId);
      await entry.manager.negotiate('remote-joined');
    }
  }

  private handleRemoteLeave(senderId: string): void {
    const participant = this.remoteById.get(senderId);
    const entry = this.peers.get(senderId);
    if (entry) {
      entry.bus.close();
      entry.manager.close();
      this.peers.delete(senderId);
    }
    if (participant) {
      this.remoteById.delete(senderId);
      this.emit('participant-left', participant);
    }
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

  /** Get (or create) the peer connection + manager for a remote participant. */
  private async ensurePeer(participantId: string): Promise<PeerEntry> {
    const existing = this.peers.get(participantId);
    if (existing) return existing;
    if (this.closed) throw new Error('Room is closed');

    const participant = this.remoteById.get(participantId);
    if (!participant) {
      // We received SDP/ICE before their join envelope arrived (unordered
      // backend): synthesize a participant shell so signaling still works.
      const shell = new RemoteParticipant({ id: participantId });
      this.remoteById.set(participantId, shell);
      this.emit('participant-joined', shell);
    }

    const pc = this.config.peerFactory
      ? this.config.peerFactory(participantId)
      : new RTCPeerConnection({ iceServers: this.config.iceServers ?? [] });
    const polite =
      typeof this.config.polite === 'function'
        ? this.config.polite(this.local.id, participantId)
        : typeof this.config.polite === 'boolean'
          ? this.config.polite
          : this.local.id < participantId;

    const bus = new DataChannelBus(pc, {
      name: this.config.dataChannelName ?? 'vidcall',
      wireOnDataChannel: false,
      debug: this.debug,
    });

    const manager = new PeerConnectionManager({
      pc,
      polite,
      autoRestartIce: this.config.autoRestartIce ?? true,
      debug: this.debug,
      onSignal: (signal) => {
        this.emitSignalTo(participantId, signal).catch((err) => this.reportError(err));
      },
      onConnectionState: (state) => {
        const p = this.remoteById.get(participantId);
        if (p) p.connectionState = state;
        this.emit('connection-state', { participantId, state });
      },
      onIceConnectionState: (state) => {
        this.emit('ice-connection-state', { participantId, state });
      },
      onDataChannel: (channel) => {
        bus.adoptRemote(channel);
      },
      onTrack: (event) => {
        this.handleRemoteTrack(participantId, event);
      },
      onError: (err) => this.reportError(err),
    });

    // Wire data-channel reactions/chat into room events.
    bus.on('reaction', (payload) =>
      this.emit('reaction', { ...payload, senderId: participantId, participantId }),
    );
    bus.on('chat', (payload) =>
      this.emit('chat', { ...payload, senderId: participantId, participantId }),
    );
    bus.on('control', (message) => this.debug('datachannel:control', { participantId, message }));

    // Re-publish existing local tracks onto the fresh connection.
    for (const publication of this.local.publications) {
      if (publication.track) pc.addTrack(publication.track);
    }

    const entry: PeerEntry = { pc, manager, bus };
    this.peers.set(participantId, entry);
    return entry;
  }

  private handleRemoteTrack(participantId: string, event: RTCTrackEvent): void {
    const participant = this.remoteById.get(participantId);
    if (!participant) return;
    const track = event.track;
    const kind = track.kind === 'audio' ? 'audio' : 'video';
    const id = track.id || randomId();
    let publication = participant.getPublication(id);
    if (!publication) {
      publication = {
        id,
        kind,
        source: kind === 'video' ? 'camera' : 'microphone',
        participantId,
        isLocal: false,
        track,
        muted: false,
      };
      participant.addPublication(publication);
      this.emit('track', { participant, publication, track });
      track.addEventListener?.('ended', () => {
        const removed = participant.removePublication(id);
        if (removed) this.emit('track-unpublished', { participant, publication: removed, track });
      });
    }
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
