/**
 * FakeMediaDevices — a scriptable `navigator.mediaDevices` for devices tests.
 *
 * Mirrors the platform seam the devices facade uses (`enumerateDevices`,
 * `getUserMedia`, `devicechange` add/removeEventListener) with test hooks:
 * devices are declared as specs, `getUserMedia` returns FakeMediaStreams
 * whose track labels match the requested device, and `fireDeviceChange()`
 * drives the `devicechange` listeners so tests can assert `devices:changed`
 * events and lifecycle cleanup.
 *
 * Like `FakeRTCPeerConnection`/`FakeMediaRecorder`, the fake is structurally
 * compatible with the seam (it deliberately does not `implements
 * MediaDevices`); tests pass it where `MediaDevicesLike` is expected.
 */
import { FakeMediaStreamTrack } from './fake-rtc.ts';
import { FakeMediaStream } from './fake-media-recorder.ts';

/** Declared device for `enumerateDevices` / `getUserMedia` label matching. */
export interface FakeDeviceSpec {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput' | 'videoinput';
  label: string;
  groupId?: string;
}

export class FakeMediaDevices {
  static readonly instances: FakeMediaDevices[] = [];

  /** Devices reported by `enumerateDevices`. */
  devices: FakeDeviceSpec[] = [];

  /** Constraints passed to the most recent `getUserMedia` call. */
  lastConstraints: MediaStreamConstraints | undefined;

  /** Streams returned by `getUserMedia` (for assertions). */
  streams: MediaStream[] = [];

  private readonly deviceChangeListeners = new Set<EventListenerOrEventListenerObject>();

  constructor() {
    FakeMediaDevices.instances.push(this);
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices.map((spec) => {
      const info = {
        deviceId: spec.deviceId,
        kind: spec.kind,
        label: spec.label,
        groupId: spec.groupId ?? '',
      };
      return { ...info, toJSON: () => info } as MediaDeviceInfo;
    });
  }

  async getUserMedia(constraints: MediaStreamConstraints = {}): Promise<MediaStream> {
    this.lastConstraints = constraints;
    const tracks: MediaStreamTrack[] = [];
    if (constraints.video) {
      const deviceId = deviceIdFromConstraint(constraints.video);
      tracks.push(new FakeMediaStreamTrack('video', this.labelFor(deviceId, 'video')));
    }
    if (constraints.audio) {
      const deviceId = deviceIdFromConstraint(constraints.audio);
      tracks.push(new FakeMediaStreamTrack('audio', this.labelFor(deviceId, 'audio')));
    }
    const stream = new FakeMediaStream(tracks) as unknown as MediaStream;
    this.streams.push(stream);
    return stream;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'devicechange' && listener) this.deviceChangeListeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'devicechange' && listener) this.deviceChangeListeners.delete(listener);
  }

  // ------------------------------------------------------------ test helpers

  /** Fire the platform 'devicechange' event to all registered listeners. */
  fireDeviceChange(): void {
    const event = new Event('devicechange');
    for (const listener of [...this.deviceChangeListeners]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  /** Number of active devicechange listeners. */
  deviceChangeListenerCount(): number {
    return this.deviceChangeListeners.size;
  }

  private labelFor(deviceId: string | undefined, fallback: string): string {
    if (!deviceId) return fallback;
    return this.devices.find((spec) => spec.deviceId === deviceId)?.label ?? fallback;
  }
}

/** Extract the primary deviceId from a `ConstrainDOMString` (best-effort). */
function deviceIdFromConstraint(constraint: boolean | MediaTrackConstraints): string | undefined {
  if (typeof constraint !== 'object' || constraint === null) return undefined;
  const deviceId = (constraint as MediaTrackConstraints).deviceId;
  if (typeof deviceId === 'string') return deviceId;
  if (Array.isArray(deviceId)) return deviceId[0];
  if (deviceId && typeof deviceId === 'object') {
    const { exact, ideal } = deviceId as { exact?: string; ideal?: string };
    return exact ?? ideal;
  }
  return undefined;
}

/** Reset fake mediaDevices state between tests. */
export function resetFakeMediaDevices(): void {
  FakeMediaDevices.instances.length = 0;
}
