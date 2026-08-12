/**
 * Devices — local media-device management for vidcall (sibling of the
 * recording hooks, docs/architecture.md D6).
 *
 * Wraps the platform `navigator.mediaDevices` API behind a small, guarded
 * surface:
 *
 *  - `listDevices(kind?)` — enumerate audio/video input/output devices,
 *  - `switchCamera()` — toggle the local camera(s) between `facingMode`
 *    `'user'` and `'environment'` via `track.applyConstraints`,
 *  - `restartTrack(kind, { deviceId })` — re-acquire a local track from a
 *    different device and `replaceTrack` it onto every sender using that
 *    kind (preserving the track's enabled state),
 *  - `setFacingMode(mode)` — explicitly set the camera facing mode.
 *
 * Environment guard: every entry point is platform-API guarded. In
 * environments without `navigator.mediaDevices` (Node, old browsers,
 * WebViews without the media permission) the facade never crashes:
 * `listDevices` resolves `[]`, `switchCamera`/`setFacingMode` resolve
 * `false`, and `restartTrack` rejects with `DevicesUnavailableError`
 * (mirroring the recording hooks' `RecordingUnavailableError`).
 *
 * Like the recording hooks, the platform seam is injectable: tests pass a
 * `MediaDevicesLike` provider (see `RoomConfig.devices.mediaDevices`).
 */
import { TypedEmitter } from './events.ts';

/** DOM `MediaDeviceKind`, re-exported under the vidcall name. */
export type DeviceKind = MediaDeviceKind;

/** Camera facing modes understood by `MediaTrackConstraints.facingMode`. */
export type FacingMode = 'user' | 'environment' | 'left' | 'right';

/** One enumerated device (see `navigator.mediaDevices.enumerateDevices`). */
export interface DeviceInfo {
  readonly deviceId: string;
  readonly kind: DeviceKind;
  readonly label: string;
  readonly groupId: string;
  /**
   * Best-effort facing hint for videoinput devices. `enumerateDevices` does
   * not expose `facingMode`, so this is derived from the device label
   * ("front/back/rear/selfie/..."). Treat it as a hint, not truth; undefined
   * for non-video devices and unidentifiable labels.
   */
  readonly facing?: FacingMode;
}

/**
 * The subset of `navigator.mediaDevices` the devices facade uses. A
 * structural seam: the platform object satisfies it directly, and tests
 * inject fakes.
 */
export interface MediaDevicesLike {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
}

/** Thrown by `restartTrack` when the platform has no mediaDevices API. */
export class DevicesUnavailableError extends Error {
  readonly code = 'DEVICES_UNAVAILABLE' as const;

  constructor(message = 'navigator.mediaDevices is not available in this environment') {
    super(message);
    this.name = 'DevicesUnavailableError';
  }
}

/** Options for `restartTrack` / `room.devices.restartTrack`. */
export interface RestartTrackOptions {
  /** Target device id (exact constraint on the re-acquired track). */
  deviceId: string;
}

/**
 * Resolve the media provider: explicit override wins, otherwise the platform
 * `navigator.mediaDevices`. Returns `undefined` when neither exists.
 */
export function detectMediaDevices(
  provider?: MediaDevicesLike | null,
): MediaDevicesLike | undefined {
  if (provider) return provider;
  if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
    return navigator.mediaDevices;
  }
  return undefined;
}

/** Facing hint patterns, checked in order (first match wins). */
const FACING_LABEL_HINTS: ReadonlyArray<readonly [FacingMode, RegExp]> = [
  ['environment', /\b(back|rear|environment|main)\b/],
  ['user', /\b(front|user|selfie)\b/],
  ['left', /\bleft\b/],
  ['right', /\bright\b/],
];

/** Best-effort facing heuristic from a device label (see `DeviceInfo.facing`). */
export function facingFromLabel(label: string): FacingMode | undefined {
  const normalized = label.toLowerCase();
  for (const [mode, pattern] of FACING_LABEL_HINTS) {
    if (pattern.test(normalized)) return mode;
  }
  return undefined;
}

/**
 * Enumerate media devices, optionally filtered by kind. Resolves `[]` when
 * the platform mediaDevices API is unavailable (never rejects on that basis).
 */
export async function listDevices(
  kind?: DeviceKind,
  provider?: MediaDevicesLike | null,
): Promise<DeviceInfo[]> {
  const mediaDevices = detectMediaDevices(provider);
  if (!mediaDevices) return [];
  const devices = await mediaDevices.enumerateDevices();
  return devices
    .filter((device) => kind === undefined || device.kind === kind)
    .map((device) => {
      const facing = device.kind === 'videoinput' ? facingFromLabel(device.label) : undefined;
      const info: DeviceInfo = {
        deviceId: device.deviceId,
        kind: device.kind,
        label: device.label,
        groupId: device.groupId,
        ...(facing ? { facing } : {}),
      };
      return info;
    });
}

/** Read the current facingMode off a track (best-effort; never throws). */
function readFacingMode(track: MediaStreamTrack): FacingMode | undefined {
  try {
    const mode = track.getSettings?.().facingMode;
    if (mode === 'user' || mode === 'environment' || mode === 'left' || mode === 'right') {
      return mode;
    }
  } catch {
    // getSettings is best-effort on some platforms.
  }
  return undefined;
}

/**
 * Toggle the local camera(s) between `facingMode` `'user'` and
 * `'environment'` via `track.applyConstraints` (unknown mode → `'environment'`).
 * Returns whether at least one video track was switched. Tracks without a
 * working `applyConstraints` are skipped.
 */
export async function switchCamera(tracks: readonly MediaStreamTrack[]): Promise<boolean> {
  let switched = false;
  for (const track of tracks) {
    if (track.kind !== 'video' || typeof track.applyConstraints !== 'function') continue;
    const next: FacingMode = readFacingMode(track) === 'environment' ? 'user' : 'environment';
    await track.applyConstraints({ facingMode: next });
    switched = true;
  }
  return switched;
}

/**
 * Explicitly set the camera facing mode on all local video tracks. Returns
 * whether at least one track was updated.
 */
export async function setFacingMode(
  tracks: readonly MediaStreamTrack[],
  mode: FacingMode,
): Promise<boolean> {
  let updated = false;
  for (const track of tracks) {
    if (track.kind !== 'video' || typeof track.applyConstraints !== 'function') continue;
    await track.applyConstraints({ facingMode: mode });
    updated = true;
  }
  return updated;
}

/**
 * Re-acquire a local track of `kind` from `options.deviceId` and replace it
 * onto every sender currently sending a track of that kind. The new track
 * inherits the enabled state of the first replaced track; replaced tracks are
 * stopped once the swap succeeds. Resolves with the new track.
 *
 * Rejects with `DevicesUnavailableError` when the platform mediaDevices API
 * is unavailable, and with an `Error` when no sender uses `kind`.
 */
export async function restartTrack(
  kind: 'audio' | 'video',
  options: RestartTrackOptions,
  provider: MediaDevicesLike | null | undefined,
  senders: readonly RTCRtpSender[],
  onReplaced?: (oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack) => void,
): Promise<MediaStreamTrack> {
  const mediaDevices = detectMediaDevices(provider);
  if (!mediaDevices) throw new DevicesUnavailableError();

  const oldTracks = [
    ...new Set(
      senders
        .map((sender) => sender.track)
        .filter((track): track is MediaStreamTrack => track !== null && track.kind === kind),
    ),
  ];
  if (oldTracks.length === 0) {
    throw new Error(`RoomDevicesFacade: no local '${kind}' sender to restart`);
  }
  const enabled = oldTracks[0]!.enabled;

  const constraints: MediaStreamConstraints =
    kind === 'audio'
      ? { audio: { deviceId: { exact: options.deviceId } }, video: false }
      : { video: { deviceId: { exact: options.deviceId } }, audio: false };
  const stream = await mediaDevices.getUserMedia(constraints);
  const newTrack = (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks())[0];
  if (!newTrack) {
    throw new Error(`RoomDevicesFacade: getUserMedia returned no '${kind}' track`);
  }
  // Preserve the muted/unmuted state across the device swap.
  newTrack.enabled = enabled;

  for (const sender of senders) {
    if (sender.track?.kind !== kind) continue;
    const oldTrack = sender.track;
    await sender.replaceTrack(newTrack);
    onReplaced?.(oldTrack, newTrack);
  }
  for (const oldTrack of oldTracks) {
    if (oldTrack !== newTrack) oldTrack.stop();
  }
  return newTrack;
}

/** Events emitted by `RoomDevicesFacade` (and re-emitted on the Room). */
export type DevicesEventMap = {
  /**
   * The platform reported a change in connected media devices (device
   * plugged/unplugged). Re-emitted on the room as `room.on('devices:changed')`.
   */
  'devices:changed': [];
};

export interface RoomDevicesFacadeOptions {
  /**
   * MediaDevices provider (default: platform `navigator.mediaDevices`).
   * Tests inject fakes; `null` forces the "unavailable" state.
   */
  mediaDevices?: MediaDevicesLike | null;
  /** All local senders across peers (wired by Room). */
  getSenders?: () => readonly RTCRtpSender[];
  /** Local video tracks for switchCamera/setFacingMode (wired by Room). */
  getLocalVideoTracks?: () => readonly MediaStreamTrack[];
  /**
   * Called after a sender's track is replaced by `restartTrack`, so the room
   * can update publication bookkeeping.
   */
  onTrackReplaced?: (
    kind: 'audio' | 'video',
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
  ) => void;
  debug?: (message: string, data?: unknown) => void;
}

/**
 * `room.devices` — local device-management facade (mirrors the recording
 * facade's structure). Wires the platform `navigator.mediaDevices` seam to
 * the room's local tracks/senders and re-emits `devices:changed` when the
 * platform reports a device change.
 *
 * ```ts
 * const cameras = await room.devices.listDevices('videoinput');
 * await room.devices.switchCamera(); // user <-> environment
 * await room.devices.restartTrack('audio', { deviceId: 'mic-2' });
 * room.on('devices:changed', () => void room.devices.listDevices());
 * ```
 *
 * Platform-guarded: in environments without `navigator.mediaDevices`
 * `listDevices` resolves `[]`, `switchCamera`/`setFacingMode` resolve
 * `false`, and `restartTrack` rejects with `DevicesUnavailableError`.
 * `Room.leave()` releases the `devicechange` subscription.
 */
export class RoomDevicesFacade extends TypedEmitter<DevicesEventMap> {
  private readonly provider: MediaDevicesLike | undefined;
  private readonly debug: (message: string, data?: unknown) => void;
  private readonly getSenders: () => readonly RTCRtpSender[];
  private readonly getLocalVideoTracks: () => readonly MediaStreamTrack[];
  private readonly onTrackReplaced: (
    kind: 'audio' | 'video',
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
  ) => void;
  private readonly deviceChangeHandler: EventListener = (): void => {
    this.emit('devices:changed');
  };
  private listening = false;

  constructor(options: RoomDevicesFacadeOptions = {}) {
    super();
    this.provider = detectMediaDevices(options.mediaDevices);
    this.debug = options.debug ?? (() => {});
    this.getSenders = options.getSenders ?? (() => []);
    this.getLocalVideoTracks = options.getLocalVideoTracks ?? (() => []);
    this.onTrackReplaced =
      options.onTrackReplaced ??
      (() => {
        /* no bookkeeping */
      });
    if (this.provider && typeof this.provider.addEventListener === 'function') {
      this.provider.addEventListener('devicechange', this.deviceChangeHandler);
      this.listening = true;
    }
  }

  /** Enumerate media devices (resolves `[]` when unavailable). */
  listDevices(kind?: DeviceKind): Promise<DeviceInfo[]> {
    return listDevices(kind, this.provider);
  }

  /** Toggle the local camera(s) between `'user'` and `'environment'`. */
  switchCamera(): Promise<boolean> {
    return switchCamera(this.getLocalVideoTracks());
  }

  /** Explicitly set the camera facing mode on all local video tracks. */
  setFacingMode(mode: FacingMode): Promise<boolean> {
    return setFacingMode(this.getLocalVideoTracks(), mode);
  }

  /**
   * Re-acquire the local track of `kind` from `deviceId` and replace it on
   * every sender using that kind (preserving the enabled state).
   */
  restartTrack(kind: 'audio' | 'video', options: RestartTrackOptions): Promise<MediaStreamTrack> {
    return restartTrack(kind, options, this.provider, this.getSenders(), (oldTrack, newTrack) =>
      this.onTrackReplaced(kind, oldTrack, newTrack),
    );
  }

  /**
   * Release the devicechange subscription. Called by `Room.leave()`; no-op
   * when not listening. Idempotent.
   */
  dispose(): void {
    if (!this.provider || !this.listening) return;
    try {
      this.provider.removeEventListener('devicechange', this.deviceChangeHandler);
    } catch (err) {
      this.debug('devices:dispose-failed', err);
    }
    this.listening = false;
  }
}
