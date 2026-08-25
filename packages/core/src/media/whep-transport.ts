/**
 * WhepMediaTransport — WHEP egress (WHIP draft §5).
 *
 * `POST /whep/:roomId` SDP offer → answer. SFU consumer → SDP answer for
 * external player. The transport is lazy: no mediasoup dep, just `fetch`.
 */

import type { Envelope } from '@mbsks/openrtc-protocol';
import type { TrackPublication } from '../participants.ts';
import type { ExtendedPublishOptions, MediaSubscribeOptions, MediaTrackEvent, MediaTransport, PeerConnectionStateEvent, TrackSubscription } from './media-transport.ts';

export interface WhepMediaTransportOptions {
  roomId: string;
  selfId: string;
  whepUrl?: string;
  token?: string;
  peerFactory?: (participantId: string) => RTCPeerConnection;
  iceServers?: RTCIceServer[];
  fetchImpl?: typeof fetch;
  debug?: (message: string, data?: unknown) => void;
}

export class WhepMediaTransport implements MediaTransport {
  readonly kind = 'whep' as const;
  private readonly opts: WhepMediaTransportOptions;
  private pc: RTCPeerConnection | null = null;
  private readonly trackCbs = new Set<(e: MediaTrackEvent) => void>();
  private readonly connCbs = new Set<(e: PeerConnectionStateEvent) => void>();
  private closed = false;

  constructor(opts: WhepMediaTransportOptions) {
    this.opts = opts;
  }

  private get fetchFn(): typeof fetch { return this.opts.fetchImpl ?? fetch; }
  private endpoint(): string { return this.opts.whepUrl ?? `/whep/${encodeURIComponent(this.opts.roomId)}`; }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = this.opts.peerFactory
      ? this.opts.peerFactory(`${this.opts.selfId}:whep`)
      : new RTCPeerConnection({ iceServers: this.opts.iceServers ?? [] });
    pc.onconnectionstatechange = () => {
      for (const cb of this.connCbs) cb({ participantId: this.opts.selfId, state: pc.connectionState });
    };
    pc.ontrack = (ev) => {
      const track = ev.track;
      const kind = track.kind === 'audio' ? 'audio' : 'video';
      for (const cb of this.trackCbs) cb({ participantId: this.opts.selfId, track: track as unknown as MediaStreamTrack, kind });
    };
    this.pc = pc;
    return pc;
  }

  async publish(_track: MediaStreamTrack, _opts?: ExtendedPublishOptions): Promise<TrackPublication> {
    throw new Error('WhepMediaTransport: publish not supported (whep is egress-only)');
  }

  async unpublish(_pub: TrackPublication): Promise<void> {}

  async subscribe(participantId: string, _opts?: MediaSubscribeOptions): Promise<TrackSubscription> {
    if (this.closed) throw new Error('WhepMediaTransport: closed');
    const pc = this.ensurePc();
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpOffer = pc.localDescription?.sdp ?? offer.sdp ?? '';
    const res = await this.fetchFn(this.endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/sdp',
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: sdpOffer,
    });
    if (!res.ok) throw new Error(`WHEP egress failed: ${res.status} ${await res.text().catch(() => '')}`);
    const sdpAnswer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });
    return {
      participantId,
      get publication(): TrackPublication | undefined { return undefined; },
      setEnabled(): void {},
      close(): void {},
    };
  }

  getSenders(): RTCRtpSender[] { return this.pc?.getSenders() ?? []; }
  getPeerConnections(): RTCPeerConnection[] { return this.pc ? [this.pc] : []; }
  onTrack(cb: (e: MediaTrackEvent) => void): () => void { this.trackCbs.add(cb); return () => this.trackCbs.delete(cb); }
  onConnectionState(cb: (e: PeerConnectionStateEvent) => void): () => void { this.connCbs.add(cb); return () => this.connCbs.delete(cb); }
  async handleEnvelope(_envelope: Envelope): Promise<boolean> { return false; }
  async close(): Promise<void> { this.closed = true; try { this.pc?.close(); } catch { /* ignore */ } this.pc = null; }
}
