/**
 * WhipMediaTransport — WHIP ingest (RFC 9725).
 *
 * `POST /whip/:roomId` SDP offer → answer. OBS / broadcaster → SFU PlainTransport
 * producer → fan-out as normal video track. The transport is lazy: no mediasoup
 * peer dep, just `fetch`.
 *
 * ```ts
 * const transport = new WhipMediaTransport({
 *   roomId, selfId,
 *   whipUrl: 'https://sfu.example.com/whip/room-42',
 *   peerFactory: id => new RTCPeerConnection({ bundlePolicy:'max-bundle' }),
 * });
 * await room.setTransport(transport); // or pass as mediaTransport
 * await transport.publish(track, { source:'camera' });
 * ```
 */

import type { Envelope } from '@mbsks/openrtc-protocol';
import type { TrackPublication } from '../participants.ts';
import type { ExtendedPublishOptions, MediaSubscribeOptions, MediaTrackEvent, MediaTransport, PeerConnectionStateEvent, TrackSubscription } from './media-transport.ts';

export interface WhipMediaTransportOptions {
  roomId: string;
  selfId: string;
  /** WHIP endpoint (e.g. `POST /whip/:roomId`). When omitted, `POST /whip/<roomId>` relative. */
  whipUrl?: string;
  token?: string;
  peerFactory?: (participantId: string) => RTCPeerConnection;
  iceServers?: RTCIceServer[];
  fetchImpl?: typeof fetch;
  debug?: (message: string, data?: unknown) => void;
}

export class WhipMediaTransport implements MediaTransport {
  readonly kind = 'whip' as const;
  private readonly opts: WhipMediaTransportOptions;
  private pc: RTCPeerConnection | null = null;
  private readonly trackCbs = new Set<(e: MediaTrackEvent) => void>();
  private readonly connCbs = new Set<(e: PeerConnectionStateEvent) => void>();
  private closed = false;

  constructor(opts: WhipMediaTransportOptions) {
    this.opts = opts;
  }

  private get fetchFn(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private endpoint(): string {
    return this.opts.whipUrl ?? `/whip/${encodeURIComponent(this.opts.roomId)}`;
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = this.opts.peerFactory
      ? this.opts.peerFactory(this.opts.selfId)
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

  async publish(track: MediaStreamTrack, opts: ExtendedPublishOptions = {}): Promise<TrackPublication> {
    if (this.closed) throw new Error('WhipMediaTransport: closed');
    const pc = this.ensurePc();
    pc.addTrack(track as unknown as MediaStreamTrack);
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
    if (!res.ok) throw new Error(`WHIP ingest failed: ${res.status} ${await res.text().catch(() => '')}`);
    const sdpAnswer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });
    const id = (track as unknown as { id?: string }).id ?? `whip-${Date.now()}`;
    return {
      id,
      kind: track.kind === 'audio' ? 'audio' : 'video',
      source: opts.source ?? (track.kind === 'audio' ? 'microphone' : 'camera'),
      participantId: this.opts.selfId,
      isLocal: true,
      track,
      muted: false,
      metadata: opts.metadata,
    };
  }

  async unpublish(pub: TrackPublication): Promise<void> {
    const track = pub.track as unknown as MediaStreamTrack | null;
    if (!track || !this.pc) return;
    const sender = this.pc.getSenders().find((s) => s.track === track);
    if (sender) {
      try { this.pc.removeTrack(sender); } catch { /* ignore */ }
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdpOffer = this.pc.localDescription?.sdp ?? offer.sdp ?? '';
      await this.fetchFn(this.endpoint(), {
        method: 'PATCH',
        headers: {
          'content-type': 'application/sdp',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: sdpOffer,
      }).catch(() => {});
    }
  }

  async subscribe(participantId: string, _opts?: MediaSubscribeOptions): Promise<TrackSubscription> {
    throw new Error(`WhipMediaTransport: subscribe not supported (whip is ingest-only); requested ${participantId}`);
  }

  getSenders(): RTCRtpSender[] { return this.pc?.getSenders() ?? []; }
  getPeerConnections(): RTCPeerConnection[] { return this.pc ? [this.pc] : []; }
  onTrack(cb: (e: MediaTrackEvent) => void): () => void { this.trackCbs.add(cb); return () => this.trackCbs.delete(cb); }
  onConnectionState(cb: (e: PeerConnectionStateEvent) => void): () => void { this.connCbs.add(cb); return () => this.connCbs.delete(cb); }
  async handleEnvelope(_envelope: Envelope): Promise<boolean> { return false; }
  async close(): Promise<void> {
    this.closed = true;
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null;
  }
}
