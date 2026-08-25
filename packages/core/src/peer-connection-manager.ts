/**
 * PeerConnectionManager — mesh core (webrtc-js.md §1.3, §4.2, docs/architecture.md D3).
 *
 * Implements the W3C **perfect negotiation** pattern (polite/impolite), trickle
 * ICE, renegotiation, and ICE restart, plus the engine-side ordering rules:
 *
 *  - **Glare**: concurrent offers are resolved by a deterministic tie-break —
 *    `polite = selfId < remoteId`. The polite peer rolls back its own in-flight
 *    offer and accepts the remote offer; the impolite peer ignores a remote
 *    offer that collides with its own.
 *  - **Trickle ICE (RFC 8838)**: `icecandidate` events are signaled as they
 *    fire; remote candidates are buffered until the matching remote description
 *    has been applied (spec requires `addIceCandidate` after
 *    `setRemoteDescription`).
 *  - **Idempotency**: retransmitted offers/answers are ignored via the SDP
 *    `o=` session-id/session-version (`SdpIdempotencyGuard`).
 *
 * The manager is transport-agnostic: it emits `PeerSignal`s that the caller
 * (e.g. `Room`) forwards over a `SignalingTransport`, and consumes
 * `PeerSignal`s coming from the wire via `handleSignal`.
 */
import type { IcePayload, OfferPayload } from '@mbsks/protocol';
import { SdpIdempotencyGuard } from './sdp.ts';

export type PeerSignal =
  | { type: 'offer'; payload: OfferPayload }
  | { type: 'answer'; payload: OfferPayload }
  | { type: 'ice'; payload: IcePayload };

export interface PeerConnectionManagerOptions {
  /** The platform RTCPeerConnection (browser, werift, wrtc, or fake). */
  pc: RTCPeerConnection;
  /** True if this peer is the polite one (typically `selfId < remoteId`). */
  polite: boolean;
  /** Called with signals that must be forwarded to the remote peer. */
  onSignal?: (signal: PeerSignal) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onIceConnectionState?: (state: RTCIceConnectionState) => void;
  onIceGatheringState?: (state: RTCIceGatheringState) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
  onTrack?: (event: RTCTrackEvent) => void;
  onError?: (error: Error) => void;
  /** Automatically restart ICE when `iceConnectionState` becomes 'failed'. */
  autoRestartIce?: boolean;
  /** Diagnostic logger (no-op by default). */
  debug?: (message: string, data?: unknown) => void;
}

/**
 * A single remote ICE candidate, possibly not yet applied.
 */
interface PendingCandidate {
  candidate: IcePayload;
  attempts: number;
}

export class PeerConnectionManager {
  readonly pc: RTCPeerConnection;
  readonly polite: boolean;

  private readonly onSignal?: (signal: PeerSignal) => void;
  private readonly onConnectionState?: (state: RTCPeerConnectionState) => void;
  private readonly onIceConnectionState?: (state: RTCIceConnectionState) => void;
  private readonly onIceGatheringState?: (state: RTCIceGatheringState) => void;
  private readonly onDataChannel?: (channel: RTCDataChannel) => void;
  private readonly onTrack?: (event: RTCTrackEvent) => void;
  private readonly onError?: (error: Error) => void;
  private readonly autoRestartIce: boolean;
  private readonly debug: (message: string, data?: unknown) => void;

  private readonly sdpGuard = new SdpIdempotencyGuard();
  private readonly pendingCandidates: PendingCandidate[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private restartingIce = false;
  private pendingRestart = false;
  private disposed = false;
  private handlersAttached = false;

  constructor(options: PeerConnectionManagerOptions) {
    this.pc = options.pc;
    this.polite = options.polite;
    this.onSignal = options.onSignal;
    this.onConnectionState = options.onConnectionState;
    this.onIceConnectionState = options.onIceConnectionState;
    this.onIceGatheringState = options.onIceGatheringState;
    this.onDataChannel = options.onDataChannel;
    this.onTrack = options.onTrack;
    this.onError = options.onError;
    this.autoRestartIce = options.autoRestartIce ?? true;
    this.debug = options.debug ?? (() => {});
    this.attach();
  }

  // ------------------------------------------------------------------ state

  get signalingState(): RTCSignalingState {
    return this.pc.signalingState;
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.pc.iceConnectionState;
  }

  /**
   * All senders on this connection (exposed for the adaptive-quality
   * controller, which reads/updates encodings via `setParameters`).
   */
  getSenders(): RTCRtpSender[] {
    return this.pc.getSenders();
  }

  // ------------------------------------------------------------ event wiring

  private attach(): void {
    if (this.handlersAttached) return;
    this.handlersAttached = true;
    this.pc.onnegotiationneeded = () => {
      this.negotiate().catch((err: unknown) => this.reportError(err, 'negotiationneeded'));
    };
    this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      const { candidate } = event;
      if (!candidate) return; // end-of-candidates marker — nothing to signal
      const payload: IcePayload = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      };
      this.debug('ice:local', payload);
      this.onSignal?.({ type: 'ice', payload });
    };
    this.pc.onconnectionstatechange = () => {
      this.debug('connectionState', this.pc.connectionState);
      this.onConnectionState?.(this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      this.debug('iceConnectionState', this.pc.iceConnectionState);
      this.onIceConnectionState?.(this.pc.iceConnectionState);
      if (this.autoRestartIce && this.pc.iceConnectionState === 'failed') {
        this.restartIce().catch((err: unknown) => this.reportError(err, 'auto-ice-restart'));
      }
    };
    this.pc.onicegatheringstatechange = () => {
      this.onIceGatheringState?.(this.pc.iceGatheringState);
    };
    this.pc.ondatachannel = (event: RTCDataChannelEvent) => {
      this.debug('datachannel:remote', event.channel.label);
      this.onDataChannel?.(event.channel);
    };
    this.pc.ontrack = (event: RTCTrackEvent) => {
      this.debug('track:remote', event.track.kind);
      this.onTrack?.(event);
    };
  }

  private detach(): void {
    if (!this.handlersAttached) return;
    this.handlersAttached = false;
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onicegatheringstatechange = null;
    this.pc.ondatachannel = null;
    this.pc.ontrack = null;
  }

  // ------------------------------------------------------------- negotiation

  /**
   * Create an offer and signal it (called from `negotiationneeded` or by the
   * caller after adding/removing tracks). Guards against overlapping offers.
   */
  async negotiate(reason = 'negotiationneeded'): Promise<void> {
    if (this.disposed) return;
    if (this.makingOffer) return;
    this.makingOffer = true;
    this.pendingRestart = false;
    try {
      this.debug('negotiate:start', reason);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const description = this.pc.localDescription;
      if (!description) {
        this.debug('negotiate:no-local-description');
        return;
      }
      this.debug('negotiate:signal-offer', description.sdp?.slice(0, 40));
      this.onSignal?.({
        type: 'offer',
        payload: { sdp: description.sdp ?? '', label: reason },
      });
    } finally {
      this.makingOffer = false;
    }
  }
  // ------------------------------------------------------------ ICE restart

  /**
   * Restart ICE: `pc.restartIce()` triggers `negotiationneeded`, which
   * produces a new offer with fresh ufrag/pwd (RFC 8445 §9). Falls back to a
   * manual renegotiation on stacks without `restartIce` (e.g. some fakes).
   */
  async restartIce(): Promise<void> {
    if (this.disposed) return;
    if (this.restartingIce) return;
    this.restartingIce = true;
    this.pendingRestart = true;
    try {
      if (typeof this.pc.restartIce === 'function') {
        this.debug('ice:restart');
        this.pc.restartIce();
      } else {
        this.debug('ice:restart-fallback');
      }
      // Give the stack one macrotask to fire negotiationneeded; if it didn't
      // (e.g. some fakes/werift), negotiate manually.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.pendingRestart) {
        await this.negotiate('ice-restart');
      }
    } finally {
      this.restartingIce = false;
    }
  }

  // ---------------------------------------------------------- remote signals

  /** Entry point for any signal arriving from the wire. */
  async handleSignal(signal: PeerSignal): Promise<void> {
    if (this.disposed) return;
    switch (signal.type) {
      case 'offer':
      case 'answer':
        await this.handleRemoteDescription(signal.type, signal.payload.sdp);
        break;
      case 'ice':
        await this.handleRemoteCandidate(signal.payload);
        break;
    }
  }

  /**
   * Apply a remote offer/answer (perfect negotiation + SDP idempotency).
   * Remote ICE candidates are flushed once the description is applied.
   */
  async handleRemoteDescription(type: 'offer' | 'answer', sdp: string): Promise<void> {
    if (this.disposed) return;

    // Idempotency: ignore retransmitted descriptions (same session-id, no newer version).
    if (this.sdpGuard.isDuplicate(type, sdp)) {
      this.debug('sdp:duplicate-ignored', { type, sdp: sdp.slice(0, 40) });
      return;
    }

    if (type === 'offer') {
      // Glare: a remote offer that collides with our in-flight offer.
      const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        this.debug('glare:ignored-remote-offer', { polite: this.polite });
        return;
      }
      if (this.polite && offerCollision) {
        // Back out of our own in-flight offer and accept theirs.
        await this.rollback();
      }
    }

    await this.pc.setRemoteDescription({ type, sdp });
    this.sdpGuard.record(type, sdp);

    if (type === 'offer') {
      await this.pc.setLocalDescription();
      const description = this.pc.localDescription;
      if (description) {
        this.onSignal?.({ type: 'answer', payload: { sdp: description.sdp ?? '' } });
      }
    } else {
      this.ignoreOffer = false;
    }

    await this.flushPendingCandidates();
  }

  /**
   * Handle a trickle ICE candidate. Candidates are buffered until the remote
   * description is applied (spec requires `addIceCandidate` after
   * `setRemoteDescription`), then flushed.
   */
  async handleRemoteCandidate(candidate: IcePayload): Promise<void> {
    if (this.disposed) return;
    if (candidate.candidate === '') {
      // End-of-candidates marker: nothing to add.
      return;
    }
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push({ candidate, attempts: 0 });
      return;
    }
    await this.addCandidate(candidate);
  }

  private async addCandidate(candidate: IcePayload): Promise<void> {
    try {
      await this.pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      });
    } catch (err) {
      if (this.ignoreOffer) {
        this.debug('ice:ignored-after-ignored-offer', candidate);
        return;
      }
      // Stacks throw InvalidStateError if the remote description changed under
      // us; re-queue and retry on the next flush.
      this.pendingCandidates.push({ candidate, attempts: 1 });
      this.debug('ice:add-failed-queued', { candidate, error: err });
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc.remoteDescription) return;
    const queue = [...this.pendingCandidates];
    this.pendingCandidates.length = 0;
    for (const entry of queue) {
      if (entry.attempts > 0) {
        // A previously failed candidate: retry once; if it fails again, drop it.
        try {
          await this.pc.addIceCandidate({
            candidate: entry.candidate.candidate,
            sdpMid: entry.candidate.sdpMid ?? undefined,
            sdpMLineIndex: entry.candidate.sdpMLineIndex ?? undefined,
          });
        } catch (err) {
          this.debug('ice:retry-failed-dropped', { candidate: entry.candidate, error: err });
        }
        continue;
      }
      await this.addCandidate(entry.candidate);
    }
  }

  /** Roll back an in-flight local offer (polite peer during glare). */
  private async rollback(): Promise<void> {
    if (this.pc.signalingState !== 'have-local-offer') return;
    try {
      await this.pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
    } catch (err) {
      // Some stacks (werift/wrtc) lack rollback; the remote offer will fail to
      // apply and surface via onError instead of being silently mishandled.
      this.debug('rollback:unsupported', err);
      throw err;
    }
  }

  // --------------------------------------------------------------- lifecycle

  /** Detach handlers and close the underlying peer connection. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    try {
      this.pc.close();
    } catch (err) {
      this.debug('close:error', err);
    }
    this.pendingCandidates.length = 0;
  }

  /** Detach handlers without closing the pc (owner manages lifecycle). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.pendingCandidates.length = 0;
  }

  private reportError(err: unknown, context: string): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.debug(`error:${context}`, error);
    this.onError?.(error);
  }
}
