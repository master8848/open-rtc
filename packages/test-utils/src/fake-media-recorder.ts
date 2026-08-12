/**
 * Fake MediaStream + MediaRecorder for recording-hook tests.
 *
 * The vidcall recording hooks build on the platform `MediaRecorder`
 * (start(timeslice)/stop()/pause()/resume(), `ondataavailable`/`onstop`/
 * `onerror`, `isTypeSupported` MIME probing). This fake mirrors that surface
 * faithfully enough to exercise hook logic in Node:
 *
 *  - `FakeMediaStream` is a minimal `MediaStream` (track list, add/remove,
 *    clone, EventTarget stubs).
 *  - `FakeMediaRecorder` validates MIME types / empty streams like the real
 *    constructor, tracks `state`, and fires the browser's async stop sequence
 *    (final `dataavailable` then `stop`) on microtasks. It does NOT schedule
 *    timeslice timers — tests drive chunks explicitly with `emitData(blob)`
 *    (the hook stamps them from its own injectable clock).
 *
 * Like `FakeRTCPeerConnection`, the fake is structurally compatible with the
 * DOM types but deliberately does not `implements MediaRecorder` (EventTarget
 * overloads); tests cast at the hook boundary where required.
 */

let streamCounter = 0;
const nextStreamId = (): string => `stream-${++streamCounter}`;

export class FakeMediaStream {
  readonly id: string;
  active = true;
  onaddtrack: ((event: Event) => unknown) | null = null;
  onremovetrack: ((event: Event) => unknown) | null = null;
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.id = nextStreamId();
    this.tracks = [...tracks];
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  getTrackById(trackId: string): MediaStreamTrack | null {
    return this.tracks.find((t) => t.id === trackId) ?? null;
  }

  addTrack(track: MediaStreamTrack): void {
    if (!this.tracks.includes(track)) {
      this.tracks.push(track);
      this.onaddtrack?.({ track } as unknown as MediaStreamTrackEvent);
    }
  }

  removeTrack(track: MediaStreamTrack): void {
    const index = this.tracks.indexOf(track);
    if (index >= 0) {
      this.tracks.splice(index, 1);
      this.onremovetrack?.({ track } as unknown as MediaStreamTrackEvent);
    }
  }

  clone(): FakeMediaStream {
    return new FakeMediaStream(this.tracks.map((t) => t.clone()));
  }

  // EventTarget stubs (the hooks only use the track list).
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
}

export class FakeMediaRecorder {
  static readonly defaultSupportedMimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  /** MIME types `isTypeSupported` accepts (tests may narrow this). */
  static supportedMimeTypes: string[] = [...FakeMediaRecorder.defaultSupportedMimeTypes];

  /** Every fake recorder constructed (tests assert on instances). */
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supportedMimeTypes.includes(mimeType);
  }

  readonly stream: MediaStream;
  readonly mimeType: string;
  readonly videoBitsPerSecond: number;
  readonly audioBitsPerSecond: number;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  timeslice: number | undefined;

  ondataavailable: ((event: BlobEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onpause: ((event: Event) => unknown) | null = null;
  onresume: ((event: Event) => unknown) | null = null;
  onstart: ((event: Event) => unknown) | null = null;
  onstop: ((event: Event) => unknown) | null = null;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    if (options?.mimeType && !FakeMediaRecorder.isTypeSupported(options.mimeType)) {
      throw new DOMException(
        `FakeMediaRecorder: MIME type '${options.mimeType}' is not supported`,
        'NotSupportedError',
      );
    }
    if (stream.getTracks().length === 0) {
      throw new DOMException('FakeMediaRecorder: stream has no tracks', 'NotSupportedError');
    }
    this.mimeType = options?.mimeType ?? '';
    this.videoBitsPerSecond = options?.videoBitsPerSecond ?? 0;
    this.audioBitsPerSecond = options?.audioBitsPerSecond ?? 0;
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    if (this.state !== 'inactive') {
      throw new DOMException(
        `FakeMediaRecorder: cannot start from '${this.state}'`,
        'InvalidStateError',
      );
    }
    this.state = 'recording';
    this.timeslice = timeslice;
    this.onstart?.(new Event('start'));
  }

  pause(): void {
    if (this.state !== 'recording') {
      throw new DOMException(
        `FakeMediaRecorder: cannot pause from '${this.state}'`,
        'InvalidStateError',
      );
    }
    this.state = 'paused';
    this.onpause?.(new Event('pause'));
  }

  resume(): void {
    if (this.state !== 'paused') {
      throw new DOMException(
        `FakeMediaRecorder: cannot resume from '${this.state}'`,
        'InvalidStateError',
      );
    }
    this.state = 'recording';
    this.onresume?.(new Event('resume'));
  }

  stop(): void {
    if (this.state === 'inactive') {
      throw new DOMException('FakeMediaRecorder: cannot stop while inactive', 'InvalidStateError');
    }
    this.state = 'inactive';
    // Browser-like async stop sequence: one final dataavailable, then stop.
    queueMicrotask(() => {
      this.ondataavailable?.({
        data: new Blob([], { type: this.mimeType }),
        timecode: 0,
      } as unknown as BlobEvent);
    });
    queueMicrotask(() => {
      this.onstop?.(new Event('stop'));
    });
  }

  requestData(): void {
    if (this.state !== 'recording') {
      throw new DOMException(
        'FakeMediaRecorder: requestData requires recording state',
        'InvalidStateError',
      );
    }
    this.ondataavailable?.({
      data: new Blob([], { type: this.mimeType }),
      timecode: 0,
    } as unknown as BlobEvent);
  }

  // ------------------------------------------------------------ test helpers

  /** Simulate a timeslice elapsing: fire `dataavailable` with `blob`. */
  emitData(blob: Blob): void {
    if (this.state !== 'recording') {
      throw new DOMException(
        'FakeMediaRecorder: emitData requires recording state',
        'InvalidStateError',
      );
    }
    this.ondataavailable?.({ data: blob, timecode: 0 } as unknown as BlobEvent);
  }

  /** Simulate a recorder failure (encoder died, tab throttled, ...). */
  fail(error: Error): void {
    this.onerror?.({ error } as unknown as Event);
  }

  // EventTarget stubs (the hooks use property handlers).
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
    if (!fn) return;
    if (type === 'dataavailable') this.ondataavailable = fn as never;
    else if (type === 'stop') this.onstop = fn as never;
    else if (type === 'error') this.onerror = fn as never;
    else if (type === 'pause') this.onpause = fn as never;
    else if (type === 'resume') this.onresume = fn as never;
    else if (type === 'start') this.onstart = fn as never;
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
    if (!fn) return;
    if (type === 'dataavailable' && this.ondataavailable === fn) this.ondataavailable = null;
    else if (type === 'stop' && this.onstop === fn) this.onstop = null;
    else if (type === 'error' && this.onerror === fn) this.onerror = null;
    else if (type === 'pause' && this.onpause === fn) this.onpause = null;
    else if (type === 'resume' && this.onresume === fn) this.onresume = null;
    else if (type === 'start' && this.onstart === fn) this.onstart = null;
  }

  dispatchEvent(event: Event): boolean {
    if (event.type === 'dataavailable') this.ondataavailable?.(event as BlobEvent);
    else if (event.type === 'stop') this.onstop?.(event);
    else if (event.type === 'error') this.onerror?.(event);
    else if (event.type === 'pause') this.onpause?.(event);
    else if (event.type === 'resume') this.onresume?.(event);
    else if (event.type === 'start') this.onstart?.(event);
    return true;
  }
}

// ------------------------------------------------------------ wiring helpers

let previousMediaRecorder: unknown = undefined;

/** Install FakeMediaRecorder as the global `MediaRecorder` (platform seam). */
export function installFakeMediaRecorder(): void {
  previousMediaRecorder = (globalThis as Record<string, unknown>).MediaRecorder;
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
}

/** Restore the pre-install global `MediaRecorder` (or remove it). */
export function uninstallFakeMediaRecorder(): void {
  if (previousMediaRecorder === undefined) {
    try {
      delete (globalThis as Record<string, unknown>).MediaRecorder;
    } catch {
      (globalThis as Record<string, unknown>).MediaRecorder = undefined;
    }
  } else {
    (globalThis as Record<string, unknown>).MediaRecorder = previousMediaRecorder;
  }
}

/** Reset fake recorder state between tests. */
export function resetFakeMediaRecorder(): void {
  FakeMediaRecorder.instances.length = 0;
  FakeMediaRecorder.supportedMimeTypes = [...FakeMediaRecorder.defaultSupportedMimeTypes];
}

/** Narrow a hook-facing MediaRecorder back to the fake for assertions. */
export function asFakeMediaRecorder(recorder: MediaRecorder): FakeMediaRecorder {
  return recorder as unknown as FakeMediaRecorder;
}
