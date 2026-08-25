/**
 * ControlsManager — local media controls for a vidcall `Room`.
 *
 * Exposes the "Zoom-clone" control surface for the local participant:
 *
 *  - mic mute/unmute and camera mute/unmute (`MediaStreamTrack.enabled`
 *    toggling, so peers keep receiving a black/silent stream),
 *  - camera on/off (publish/unpublish via `getUserMedia`),
 *  - screen share (`getDisplayMedia` + `RTCRtpSender.replaceTrack` when a
 *    camera track is already published, avoiding renegotiation),
 *  - raise hand + reactions (reuses the wire-protocol `reaction` envelope),
 *  - device selection + `devicechange` handling (`enumerateDevices`).
 *
 * Everything media-related is injected through a `ControlsMediaProvider`, so
 * the manager is fully testable in Node without a browser (see
 * `packages/core/test/controls.test.ts`).
 *
 * The manager is attached to a `Room` as `room.controls` (wired by
 * `@mbsks/openrtc-core`'s index; see docs/features/controls.md). `Room` satisfies
 * the minimal `ControlsHost` contract structurally — no subclassing needed.
 *
 * Zero runtime dependencies: builds on platform Web APIs only.
 */
import { TypedEmitter } from '../events.ts';
import type { LocalParticipant, TrackPublication } from '../participants.ts';
import type { PublishOptions } from '../room.ts';

/** Conventional emoji for raise-hand reactions (wire `ReactionPayload.emoji`). */
export const RAISE_HAND_EMOJI = '✋';

/**
 * Default audio capture constraints (docs/research/webrtc-js.md §7.3): the
 * browser's echo canceller, noise suppression, and auto-gain control are the
 * first line of defense against echo/background noise. Apps may override.
 */
export const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Injectable media access (defaults to `navigator.mediaDevices`). Tests
 * substitute a fake so no browser APIs are touched in Node.
 */
export interface ControlsMediaProvider {
  /** `navigator.mediaDevices.getUserMedia` equivalent. */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** `navigator.mediaDevices.getDisplayMedia` equivalent (screen capture). */
  getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  /** `navigator.mediaDevices.enumerateDevices` equivalent. */
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  /**
   * Subscribe to the platform `devicechange` event. Returns an unsubscribe
   * function (called by `dispose()`).
   */
  onDeviceChange(callback: () => void): () => void;
}

/**
 * The minimal `Room` surface `ControlsManager` needs. `Room` satisfies this
 * structurally; a custom host can be supplied for tests or alternate engines.
 */
export interface ControlsHost {
  /** Local participant (holds the local `TrackPublication`s). */
  readonly local: LocalParticipant;
  /** Publish a local track to every peer (see `Room.publish`). */
  publish(track: MediaStreamTrack, options?: PublishOptions): Promise<TrackPublication>;
  /** Stop publishing a local track (see `Room.unpublish`). */
  unpublish(publication: TrackPublication): Promise<void>;
  /** Broadcast a `screen-share` envelope (`start`/`stop`). */
  announceScreenShare(action: 'start' | 'stop', label?: string): Promise<void>;
  /** Broadcast a `reaction` envelope (wire protocol `ReactionPayload`). */
  sendReaction(emoji: string, targetSenderId?: string): Promise<void>;
  /** Remote participant ids (used for `replaceTrack` fan-out). */
  getParticipants?(): readonly { id: string }[];
  /** The peer connection for a remote participant (used for `replaceTrack`). */
  getPeerConnection?(participantId: string): RTCPeerConnection | undefined;
}

export interface ControlsOptions {
  /** Media access seam (default: `navigator.mediaDevices` when available). */
  mediaProvider?: ControlsMediaProvider;
  /** Emoji sent for raise-hand reactions (default `RAISE_HAND_EMOJI`). */
  raiseHandEmoji?: string;
  /** Preferred device ids applied to the next acquisition. */
  preferredDevices?: { audioinput?: string; videoinput?: string };
  /** Auto-refresh the device list on `devicechange` (default true). */
  watchDeviceChanges?: boolean;
  /** Diagnostic logger. */
  debug?: (message: string, data?: unknown) => void;
}

/** Categorized media device list (subset of `MediaDeviceInfo.kind`). */
export interface ControlsDevices {
  audioinput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
}

/** Snapshot of all local control state. */
export interface ControlsState {
  /** Microphone mute flag (track still published, `enabled=false`). */
  micMuted: boolean;
  /** Camera mute flag (track still published, `enabled=false`). */
  cameraMuted: boolean;
  /** Whether a camera video track is currently published. */
  cameraPublishing: boolean;
  /** Whether a screen-share track is currently published. */
  screenSharing: boolean;
  /** Local raise-hand flag. */
  handRaised: boolean;
  /** Last known media device list (empty until `listDevices()` is called). */
  devices: ControlsDevices;
}

export type ScreenShareStopReason = 'user' | 'track-ended' | 'error';

export type ControlsEventMap = {
  /** Microphone mute state changed (`true` = muted). */
  'mic-muted': [muted: boolean];
  /** Camera mute state changed (`true` = muted). */
  'camera-muted': [muted: boolean];
  /** Camera publish state changed (`true` = publishing). */
  'camera-published': [publishing: boolean];
  /** Screen share started. */
  'screen-share-started': [{ track: MediaStreamTrack; label?: string }];
  /** Screen share stopped (`reason: 'user' | 'track-ended' | 'error'`). */
  'screen-share-stopped': [{ reason: ScreenShareStopReason; error?: Error }];
  /** A device was selected for capture (`kind` + `deviceId`). */
  'device-selected': [{ kind: 'audioinput' | 'videoinput'; deviceId: string }];
  /** The full device list changed (platform `devicechange` event). */
  'devices-changed': [devices: MediaDeviceInfo[]];
  /** Local raise-hand state changed. */
  'hand-raised': [raised: boolean];
  error: [Error];
};

/** Lazily-built default provider backed by `navigator.mediaDevices`. */
function defaultMediaProvider(): ControlsMediaProvider {
  const mediaDevices =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices !== 'undefined'
      ? navigator.mediaDevices
      : undefined;
  const unavailable = (api: string) =>
    new Error(`ControlsManager: ${api} is unavailable (browser media devices required)`);
  return {
    async getUserMedia(constraints) {
      if (!mediaDevices) throw unavailable('getUserMedia');
      return mediaDevices.getUserMedia(constraints);
    },
    async getDisplayMedia(constraints) {
      if (!mediaDevices) throw unavailable('getDisplayMedia');
      return mediaDevices.getDisplayMedia(constraints ?? { video: true });
    },
    async enumerateDevices() {
      if (!mediaDevices) throw unavailable('enumerateDevices');
      return mediaDevices.enumerateDevices();
    },
    onDeviceChange(callback) {
      if (!mediaDevices || typeof mediaDevices.addEventListener !== 'function') {
        return () => {};
      }
      mediaDevices.addEventListener('devicechange', callback);
      return () => mediaDevices.removeEventListener('devicechange', callback);
    },
  };
}

/**
 * Local media controls for a vidcall `Room` (attached as `room.controls`).
 *
 * ```ts
 * const controls = room.controls; // wired by @mbsks/openrtc-core
 * await controls.toggleCamera();          // publish the camera
 * await controls.setMicrophoneMuted(true); // mute (peers hear silence)
 * await controls.toggleScreenShare();     // share the screen
 * await controls.raiseHand();             // sends a '✋' reaction
 * controls.on('mic-muted', (muted) => setMicButton(muted));
 * ```
 */
export class ControlsManager extends TypedEmitter<ControlsEventMap> {
  /** The host room (satisfies `ControlsHost` structurally). */
  readonly host: ControlsHost;
  private readonly media: ControlsMediaProvider;
  private readonly raiseHandEmoji: string;
  private readonly debugFn: (message: string, data?: unknown) => void;
  private readonly deviceUnsubscribe: () => void;

  private micMutedFlag = false;
  private cameraMutedFlag = false;
  private handRaisedFlag = false;
  private screenSharingFlag = false;
  /** 'replace' = screen track swapped onto the camera's senders (no renegotiation). */
  private screenShareMode: 'replace' | 'separate' | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private screenPublication: TrackPublication | null = null;
  private preferredDevices: { audioinput?: string; videoinput?: string };
  private devices: ControlsDevices = { audioinput: [], videoinput: [], audiooutput: [] };
  private deviceCacheKey = '';
  private disposed = false;

  constructor(host: ControlsHost, options: ControlsOptions = {}) {
    super();
    this.host = host;
    this.media = options.mediaProvider ?? defaultMediaProvider();
    this.raiseHandEmoji = options.raiseHandEmoji ?? RAISE_HAND_EMOJI;
    this.preferredDevices = { ...options.preferredDevices };
    this.debugFn = options.debug ?? (() => {});
    this.deviceUnsubscribe =
      options.watchDeviceChanges === false
        ? () => {}
        : this.media.onDeviceChange(() => {
            this.refreshDevices().catch((err) => this.reportError(err));
          });
  }

  // ------------------------------------------------------------- state

  get state(): ControlsState {
    return {
      micMuted: this.micMutedFlag,
      cameraMuted: this.cameraMutedFlag,
      cameraPublishing: this.findPublication('video', 'camera')?.track !== undefined,
      screenSharing: this.screenSharingFlag,
      handRaised: this.handRaisedFlag,
      devices: {
        audioinput: [...this.devices.audioinput],
        videoinput: [...this.devices.videoinput],
        audiooutput: [...this.devices.audiooutput],
      },
    };
  }

  get micMuted(): boolean {
    return this.micMutedFlag;
  }

  get cameraMuted(): boolean {
    return this.cameraMutedFlag;
  }

  get cameraPublishing(): boolean {
    return this.state.cameraPublishing;
  }

  get screenSharing(): boolean {
    return this.screenSharingFlag;
  }

  get handRaised(): boolean {
    return this.handRaisedFlag;
  }

  // ---------------------------------------------------------- microphone

  /**
   * Acquire the microphone (`getUserMedia`) and publish it, applying the
   * current mute flag (mute-before-join). Idempotent: returns the existing
   * publication if a live mic track is already published.
   */
  async startMicrophone(constraints?: MediaTrackConstraints): Promise<TrackPublication | null> {
    const existing = this.findPublication('audio', 'microphone');
    if (existing?.track) return existing;
    const audio = this.audioConstraints(constraints);
    const stream = await this.media.getUserMedia({ audio, video: false });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('ControlsManager: getUserMedia returned no audio track');
    }
    track.enabled = !this.micMutedFlag;
    const publication = await this.host.publish(track, { source: 'microphone' });
    publication.muted = this.micMutedFlag;
    return publication;
  }

  /** Stop publishing the microphone and stop the local track. */
  async stopMicrophone(): Promise<void> {
    const publication = this.findPublication('audio', 'microphone');
    if (!publication) return;
    await this.host.unpublish(publication);
    publication.track?.stop();
  }

  /**
   * Mute/unmute the microphone. The track stays published; `enabled=false`
   * makes the encoder emit silence/comfort noise to peers (not a disconnect).
   * Safe to call before any mic track exists (mute-before-join): the flag is
   * applied when the track is acquired (e.g. by `startMicrophone()`).
   */
  async setMicrophoneMuted(muted: boolean): Promise<boolean> {
    this.micMutedFlag = muted;
    const publication = this.findPublication('audio', 'microphone');
    if (publication) {
      publication.muted = muted;
      if (publication.track) publication.track.enabled = !muted;
    }
    this.emit('mic-muted', muted);
    return muted;
  }

  /** Toggle the microphone mute flag. Returns the new muted state. */
  async toggleMicrophone(): Promise<boolean> {
    return this.setMicrophoneMuted(!this.micMutedFlag);
  }

  // --------------------------------------------------------------- camera

  /**
   * Publish the camera (or return true if already publishing). The camera
   * mute flag (and preferred `videoinput` device) is applied on acquisition.
   */
  async startCamera(constraints?: MediaTrackConstraints): Promise<boolean> {
    const existing = this.findPublication('video', 'camera');
    if (existing?.track) return true;
    const video = this.videoConstraints(constraints);
    const stream = await this.media.getUserMedia({ audio: false, video });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('ControlsManager: getUserMedia returned no video track');
    }
    track.enabled = !this.cameraMutedFlag;
    const publication = await this.host.publish(track, { source: 'camera' });
    publication.muted = this.cameraMutedFlag;
    this.emit('camera-published', true);
    return true;
  }

  /**
   * Stop publishing the camera and stop the local track. If the screen share
   * is currently replacing the camera slot, the share is stopped first.
   * Returns true if a camera was published.
   */
  async stopCamera(): Promise<boolean> {
    const publication = this.findPublication('video', 'camera');
    if (!publication) return false;
    if (this.screenShareMode === 'replace') {
      await this.stopScreenShare('user');
    }
    await this.host.unpublish(publication);
    publication.track?.stop();
    this.emit('camera-published', false);
    return true;
  }

  /**
   * Toggle camera publishing on/off (`getUserMedia` + `publish`, or
   * `unpublish` + `stop`). Returns the new publishing state.
   */
  async toggleCamera(constraints?: MediaTrackConstraints): Promise<boolean> {
    if (this.state.cameraPublishing) {
      await this.stopCamera();
      return false;
    }
    await this.startCamera(constraints);
    return true;
  }

  /**
   * Mute/unmute the camera. The track stays published; `enabled=false` makes
   * the encoder emit black frames to peers. Safe to call before any camera
   * track exists (mute-before-join): applied on the next acquisition.
   */
  async setCameraMuted(muted: boolean): Promise<boolean> {
    this.cameraMutedFlag = muted;
    const publication = this.findPublication('video', 'camera');
    if (publication) {
      publication.muted = muted;
      if (publication.track) publication.track.enabled = !muted;
    }
    this.emit('camera-muted', muted);
    return muted;
  }

  /** Toggle the camera mute flag. Returns the new muted state. */
  async toggleCameraMuted(): Promise<boolean> {
    return this.setCameraMuted(!this.cameraMutedFlag);
  }

  // ---------------------------------------------------------- screen share

  /**
   * Toggle screen sharing. Returns the new sharing state.
   *
   * When a camera track is already published to every peer, the display
   * track is swapped onto the camera's senders with `RTCRtpSender.replaceTrack`
   * — no SDP renegotiation, and the camera feed resumes when sharing stops.
   * Otherwise a separate `screen` track is published (new m-line, one
   * renegotiation). The browser's native "Stop sharing" button ends the
   * share automatically (`track.onended`).
   */
  async toggleScreenShare(): Promise<boolean> {
    if (this.screenSharingFlag) {
      await this.stopScreenShare('user');
      return false;
    }
    await this.startScreenShare();
    return true;
  }

  /** Start screen sharing (see `toggleScreenShare`). Returns true if sharing. */
  async startScreenShare(): Promise<boolean> {
    if (this.screenSharingFlag) return true;
    const stream = await this.media.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('ControlsManager: getDisplayMedia returned no video track');
    }
    for (const t of stream.getAudioTracks()) t.stop();

    const camera = this.findPublication('video', 'camera');
    if (camera?.track && this.everyPeerSends(camera.track)) {
      // Replace-mode: swap the camera's senders to the display track.
      await this.replaceSenders(camera.track, track);
      this.screenShareMode = 'replace';
    } else {
      // Separate-mode: publish a new screen track (new m-line).
      const publication = await this.host.publish(track, { source: 'screen' });
      this.screenPublication = publication;
      this.screenShareMode = 'separate';
    }

    this.screenTrack = track;
    this.screenSharingFlag = true;
    // The browser ends the display track when the user clicks its native
    // "Stop sharing" button; end the share automatically in that case.
    track.addEventListener?.('ended', () => {
      this.stopScreenShare('track-ended').catch((err) => this.reportError(err));
    });
    await this.host.announceScreenShare('start', track.label);
    this.emit('screen-share-started', { track, label: track.label });
    return true;
  }

  /**
   * Stop screen sharing: restore the camera track (replace-mode) or unpublish
   * the screen track (separate-mode), stop the display track, and announce
   * the stop. Idempotent — returns false if not sharing.
   */
  async stopScreenShare(reason: ScreenShareStopReason = 'user', error?: Error): Promise<boolean> {
    if (!this.screenSharingFlag) return false;
    this.screenSharingFlag = false;
    const track = this.screenTrack;
    const mode = this.screenShareMode;
    this.screenTrack = null;
    this.screenShareMode = null;

    if (mode === 'replace') {
      const camera = this.findPublication('video', 'camera');
      if (track && camera?.track) {
        await this.replaceSenders(track, camera.track);
      }
    } else if (this.screenPublication) {
      const publication = this.screenPublication;
      this.screenPublication = null;
      await this.host.unpublish(publication);
    }

    if (track) {
      track.enabled = true;
      track.stop();
    }
    await this.host.announceScreenShare('stop');
    this.emit('screen-share-stopped', { reason, error });
    return true;
  }

  // ------------------------------------------------- reactions / raise hand

  /** Broadcast a reaction (wire protocol `reaction` envelope). */
  async sendReaction(emoji: string, targetSenderId?: string): Promise<void> {
    await this.host.sendReaction(emoji, targetSenderId);
  }

  /**
   * Raise the hand: broadcasts a `raiseHandEmoji` (`✋`) reaction and sets the
   * local `handRaised` flag. Remote apps render the reaction overlay; the
   * flag is purely local (lower it with `lowerHand()`).
   */
  async raiseHand(targetSenderId?: string): Promise<boolean> {
    await this.host.sendReaction(this.raiseHandEmoji, targetSenderId);
    this.handRaisedFlag = true;
    this.emit('hand-raised', true);
    return true;
  }

  /** Clear the local raise-hand flag. Returns true if a hand was raised. */
  async lowerHand(): Promise<boolean> {
    if (!this.handRaisedFlag) return false;
    this.handRaisedFlag = false;
    this.emit('hand-raised', false);
    return true;
  }

  /** Toggle the local raise-hand flag. Returns the new raised state. */
  async toggleHand(targetSenderId?: string): Promise<boolean> {
    if (this.handRaisedFlag) {
      await this.lowerHand();
      return false;
    }
    await this.raiseHand(targetSenderId);
    return true;
  }

  // --------------------------------------------------------------- devices

  /** Enumerate media devices and cache the categorized list. */
  async listDevices(): Promise<MediaDeviceInfo[]> {
    const list = await this.media.enumerateDevices();
    this.updateDevices(list);
    return list;
  }

  /**
   * Select the microphone device. Tries `applyConstraints({deviceId})` on the
   * live track (no renegotiation); if the browser rejects it, re-acquires via
   * `getUserMedia` and swaps the track onto existing senders with
   * `replaceTrack`. The choice is remembered for future acquisitions even
   * before a track exists.
   */
  async setMicrophoneDevice(deviceId: string): Promise<void> {
    this.preferredDevices.audioinput = deviceId;
    const publication = this.findPublication('audio', 'microphone');
    if (!publication?.track) {
      this.emit('device-selected', { kind: 'audioinput', deviceId });
      return;
    }
    await this.switchTrack(publication, 'audioinput', deviceId);
  }

  /**
   * Select the camera device. Same strategy as `setMicrophoneDevice`
   * (`applyConstraints`, then re-acquire + `replaceTrack` fallback), and the
   * choice is applied to the next camera publication if none is live.
   */
  async setCameraDevice(deviceId: string): Promise<void> {
    this.preferredDevices.videoinput = deviceId;
    const publication = this.findPublication('video', 'camera');
    if (!publication?.track) {
      this.emit('device-selected', { kind: 'videoinput', deviceId });
      return;
    }
    await this.switchTrack(publication, 'videoinput', deviceId);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Release the `devicechange` subscription and drop all listeners. The
   * host's publications are left untouched (the room owns them).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deviceUnsubscribe();
    this.removeAllListeners();
  }

  // ------------------------------------------------------------- internals

  private get debug(): (message: string, data?: unknown) => void {
    return this.debugFn;
  }

  private findPublication(
    kind: 'audio' | 'video',
    source: 'microphone' | 'camera' | 'screen',
  ): TrackPublication | undefined {
    return this.host.local.publications.find(
      (p) => p.kind === kind && p.source === source && p.track !== null,
    );
  }

  private audioConstraints(extra?: MediaTrackConstraints): MediaTrackConstraints {
    return {
      ...DEFAULT_AUDIO_CONSTRAINTS,
      ...extra,
      ...(this.preferredDevices.audioinput
        ? { deviceId: { exact: this.preferredDevices.audioinput } }
        : {}),
    };
  }

  private videoConstraints(extra?: MediaTrackConstraints): MediaTrackConstraints {
    return {
      ...extra,
      ...(this.preferredDevices.videoinput
        ? { deviceId: { exact: this.preferredDevices.videoinput } }
        : {}),
    };
  }

  /** True when every peer's connection has a sender for `track`. */
  private everyPeerSends(track: MediaStreamTrack): boolean {
    const participants = this.host.getParticipants?.() ?? [];
    if (participants.length === 0) return false;
    return participants.every((participant) => {
      const pc = this.host.getPeerConnection?.(participant.id);
      if (!pc) return false;
      return pc.getSenders().some((sender) => sender.track === track);
    });
  }

  /** Swap `oldTrack` for `newTrack` on every sender that carries it. */
  private async replaceSenders(
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack | null,
  ): Promise<void> {
    const participants = this.host.getParticipants?.() ?? [];
    for (const participant of participants) {
      const pc = this.host.getPeerConnection?.(participant.id);
      if (!pc) continue;
      for (const sender of pc.getSenders()) {
        if (sender.track === oldTrack) {
          await sender.replaceTrack(newTrack);
        }
      }
    }
  }

  /**
   * Switch the live track of a publication to a different device:
   * `applyConstraints` first (no renegotiation, no capture restart), then
   * re-acquire + `replaceTrack` fallback for browsers that reject it.
   */
  private async switchTrack(
    publication: TrackPublication,
    kind: 'audioinput' | 'videoinput',
    deviceId: string,
  ): Promise<void> {
    const muted = kind === 'audioinput' ? this.micMutedFlag : this.cameraMutedFlag;
    const oldTrack = publication.track;
    if (oldTrack) {
      try {
        await oldTrack.applyConstraints({ deviceId: { exact: deviceId } });
        this.emit('device-selected', { kind, deviceId });
        return;
      } catch (err) {
        this.debug('controls:apply-constraints-failed', { deviceId, err });
        // Fall through to re-acquisition + replaceTrack.
      }
    }
    const constraints: MediaStreamConstraints =
      kind === 'audioinput'
        ? { audio: { ...DEFAULT_AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } }, video: false }
        : { audio: false, video: { deviceId: { exact: deviceId } } };
    const stream = await this.media.getUserMedia(constraints);
    const newTrack = (kind === 'audioinput' ? stream.getAudioTracks() : stream.getVideoTracks())[0];
    if (!newTrack) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error(
        `ControlsManager: getUserMedia returned no ${kind === 'audioinput' ? 'audio' : 'video'} track`,
      );
    }
    if (oldTrack) {
      await this.replaceSenders(oldTrack, newTrack);
      oldTrack.stop();
    }
    publication.track = newTrack;
    publication.muted = muted;
    newTrack.enabled = !muted;
    this.emit('device-selected', { kind, deviceId });
  }

  private updateDevices(list: MediaDeviceInfo[]): void {
    const key = list.map((d) => `${d.kind}:${d.deviceId}`).join('|');
    if (key === this.deviceCacheKey) return;
    this.deviceCacheKey = key;
    this.devices = {
      audioinput: list.filter((d) => d.kind === 'audioinput'),
      videoinput: list.filter((d) => d.kind === 'videoinput'),
      audiooutput: list.filter((d) => d.kind === 'audiooutput'),
    };
    this.emit('devices-changed', list);
  }

  private async refreshDevices(): Promise<void> {
    try {
      const list = await this.media.enumerateDevices();
      this.updateDevices(list);
    } catch (err) {
      this.reportError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private reportError(err: Error): void {
    this.debug('controls:error', err);
    this.emit('error', err);
  }
}
