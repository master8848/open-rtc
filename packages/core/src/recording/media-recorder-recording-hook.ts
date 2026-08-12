/**
 * `MediaRecorderRecordingHook` — the default browser `RecordingHook`
 * implementation (docs/architecture.md D6).
 *
 * Records one `MediaStream` through the platform `MediaRecorder`:
 *
 *  - MIME probing: `video/webm;codecs=vp9,opus` → `vp8` → `video/webm` →
 *    platform default (whatever `MediaRecorder.isTypeSupported` accepts),
 *  - timeslice chunking (default 1s): each `dataavailable` fires a
 *    `recording:blob-chunk` event stamped with `now() - timeOrigin` so chunks
 *    from multiple recorders share one timeline,
 *  - on `stop()` the collected `BlobPart`s are assembled into one complete
 *    `Blob` and (optionally) an in-memory object URL.
 *
 * Environment guard: when the platform has no `MediaRecorder` (Node, old
 * browsers) the hook does NOT crash — `getState()` reports `'unavailable'`,
 * `start()` rejects with `RecordingUnavailableError`, and `stop()` no-ops.
 */
import { TypedEmitter } from '../events.ts';
import type {
  RecordingChunk,
  RecordingHook,
  RecordingHookEventMap,
  RecordingStartOptions,
  RecordingStartedEvent,
  RecordingStoppedEvent,
  RecordingState,
  RecordingStreamKind,
} from './recording-hook.ts';
import { RecordingUnavailableError } from './recording-hook.ts';

/** Structural platform seam: the DOM `MediaRecorder` constructor. */
export type MediaRecorderConstructor = typeof MediaRecorder;

/** MIME candidates probed in order (vp9 → vp8 → container default). */
export const DEFAULT_RECORDING_MIME_TYPES: readonly string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/**
 * Pick the first MIME candidate the platform recorder supports.
 * Returns '' (platform default) when nothing matches or probing is impossible.
 */
export function probeMimeType(
  candidates: readonly string[],
  ctor?: MediaRecorderConstructor,
): string {
  if (!ctor || typeof ctor.isTypeSupported !== 'function') return '';
  for (const candidate of candidates) {
    try {
      if (ctor.isTypeSupported(candidate)) return candidate;
    } catch {
      // A broken isTypeSupported must not take recording down with it.
    }
  }
  return '';
}

export interface MediaRecorderHookOptions {
  /** Stream to record (audio, video, or both). */
  stream: MediaStream;
  /** MIME candidates to probe (default: DEFAULT_RECORDING_MIME_TYPES). */
  mimeTypes?: readonly string[];
  /** `dataavailable` timeslice in ms (default 1000). */
  timesliceMs?: number;
  /** Stream id reported on events ('local', 'remote:<participantId>'). */
  streamId?: string;
  /** Human label reported on events. */
  label?: string;
  kind?: RecordingStreamKind;
  /** Also create an in-memory object URL for the final Blob. */
  createObjectUrl?: boolean;
  /** Target video bitrate hint passed to MediaRecorder. */
  videoBitsPerSecond?: number;
  /** Timeline clock; chunk timestamps = `now() - timeOrigin` (default Date.now). */
  now?: () => number;
  /** MediaRecorder constructor (tests inject fakes; default: platform). */
  mediaRecorderCtor?: MediaRecorderConstructor | null;
  /** Explicit support override (default: platform detection). */
  supported?: boolean;
}

function detectMediaRecorderSupport(ctor?: MediaRecorderConstructor | null): boolean {
  const candidate = ctor ?? (typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined);
  return typeof candidate === 'function';
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class MediaRecorderRecordingHook
  extends TypedEmitter<RecordingHookEventMap>
  implements RecordingHook
{
  private readonly stream: MediaStream;
  private readonly mimeTypes: readonly string[];
  private readonly timesliceMs: number;
  private readonly streamId?: string;
  private readonly label?: string;
  private readonly kind: RecordingStreamKind;
  private readonly createObjectUrl: boolean;
  private readonly videoBitsPerSecond?: number;
  private readonly now: () => number;
  private readonly ctor?: MediaRecorderConstructor;
  private readonly supported: boolean;

  private recorder: MediaRecorder | null = null;
  private state_: RecordingState;
  private parts: BlobPart[] = [];
  private chunkIndex = 0;
  private startedAtMs = 0;
  /** Common-timeline anchor captured at start (see RecordingStartOptions). */
  private origin = 0;
  private stopPromise: Promise<RecordingStoppedEvent | undefined> | null = null;
  private resolveStop: ((event: RecordingStoppedEvent | undefined) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;

  constructor(options: MediaRecorderHookOptions) {
    super();
    this.stream = options.stream;
    this.mimeTypes = options.mimeTypes ?? DEFAULT_RECORDING_MIME_TYPES;
    this.timesliceMs = options.timesliceMs ?? 1000;
    this.streamId = options.streamId;
    this.label = options.label;
    this.kind = options.kind ?? 'local';
    this.createObjectUrl = options.createObjectUrl ?? false;
    this.videoBitsPerSecond = options.videoBitsPerSecond;
    this.now = options.now ?? (() => Date.now());
    this.ctor =
      options.mediaRecorderCtor ??
      (typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined);
    this.supported = options.supported ?? detectMediaRecorderSupport(this.ctor);
    this.state_ = this.supported ? 'idle' : 'unavailable';
  }

  getState(): RecordingState {
    return this.state_;
  }

  async start(options: RecordingStartOptions = {}): Promise<RecordingStartedEvent> {
    if (!this.supported || !this.ctor) {
      throw new RecordingUnavailableError();
    }
    if (
      this.state_ === 'recording' ||
      this.state_ === 'paused' ||
      this.state_ === 'starting' ||
      this.state_ === 'stopping'
    ) {
      throw new Error(`MediaRecorderRecordingHook: cannot start in state '${this.state_}'`);
    }

    const mimeType = probeMimeType(this.mimeTypes, this.ctor);
    const recorderOptions: MediaRecorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      ...(this.videoBitsPerSecond !== undefined
        ? { videoBitsPerSecond: this.videoBitsPerSecond }
        : {}),
    };

    let recorder: MediaRecorder;
    try {
      recorder = new this.ctor(this.stream, recorderOptions);
    } catch (err) {
      const error = toError(err);
      this.state_ = 'error';
      this.emit('recording:error', {
        error,
        streamId: this.streamId,
        label: this.label,
        kind: this.kind,
        code: 'recorder',
      });
      throw error;
    }

    this.recorder = recorder;
    this.parts = [];
    this.chunkIndex = 0;
    this.startedAtMs = this.now();
    this.origin = options.timeOrigin ?? this.startedAtMs;
    this.state_ = 'recording';

    recorder.ondataavailable = (event) => this.handleData(event);
    recorder.onerror = (event) => this.handleError(event);
    recorder.onstop = () => this.handleStop();
    try {
      recorder.start(this.timesliceMs);
    } catch (err) {
      const error = toError(err);
      this.recorder = null;
      this.state_ = 'error';
      this.emit('recording:error', {
        error,
        streamId: this.streamId,
        label: this.label,
        kind: this.kind,
        code: 'recorder',
      });
      throw error;
    }

    const event: RecordingStartedEvent = {
      startedAtMs: this.startedAtMs,
      mimeType: recorder.mimeType || mimeType,
      streamId: this.streamId,
      label: this.label,
      kind: this.kind,
    };
    this.emit('recording:started', event);
    return event;
  }

  async stop(): Promise<RecordingStoppedEvent | undefined> {
    if (this.state_ === 'unavailable') return undefined;
    const recorder = this.recorder;
    if (!recorder || this.state_ === 'idle' || this.state_ === 'error') return undefined;
    if (this.state_ === 'stopping' && this.stopPromise) return this.stopPromise;

    this.state_ = 'stopping';
    this.stopPromise = new Promise<RecordingStoppedEvent | undefined>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    try {
      recorder.stop();
    } catch (err) {
      const error = toError(err);
      this.state_ = 'error';
      this.emit('recording:error', {
        error,
        streamId: this.streamId,
        label: this.label,
        kind: this.kind,
        code: 'recorder',
      });
      this.rejectStop?.(error);
    }
    return this.stopPromise;
  }

  pause(): void {
    if (this.state_ === 'paused') return;
    if (this.state_ !== 'recording') {
      throw new Error(`MediaRecorderRecordingHook: cannot pause in state '${this.state_}'`);
    }
    this.recorder?.pause();
    this.state_ = 'paused';
  }

  resume(): void {
    if (this.state_ !== 'paused') {
      throw new Error(`MediaRecorderRecordingHook: cannot resume in state '${this.state_}'`);
    }
    this.recorder?.resume();
    this.state_ = 'recording';
  }

  // ------------------------------------------------------------- internals

  private handleData(event: BlobEvent): void {
    if (!this.recorder) return;
    const blob = event.data;
    if (!blob || blob.size === 0) return;
    this.parts.push(blob);
    const chunk: RecordingChunk = {
      index: this.chunkIndex++,
      blob,
      mimeType: this.recorder.mimeType || blob.type || '',
      timestampMs: Math.max(0, this.now() - this.origin),
      streamId: this.streamId,
      label: this.label,
      kind: this.kind,
    };
    this.emit('recording:blob-chunk', chunk);
  }

  private handleError(event: Event): void {
    const raw = (event as { error?: unknown }).error;
    const error = toError(raw ?? 'MediaRecorder error');
    this.recorder = null;
    this.state_ = 'error';
    this.emit('recording:error', {
      error,
      streamId: this.streamId,
      label: this.label,
      kind: this.kind,
      code: 'recorder',
    });
    this.rejectStop?.(error);
  }

  private handleStop(): void {
    const recorder = this.recorder;
    this.recorder = null;
    // A previous error already settled this session (and its stop promise).
    if (this.state_ === 'error' || this.state_ === 'unavailable') return;

    const mimeType = recorder?.mimeType ?? '';
    const blob = new Blob(this.parts, { type: mimeType });
    this.parts = [];
    let objectUrl: string | undefined;
    if (
      this.createObjectUrl &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      try {
        objectUrl = URL.createObjectURL(blob);
      } catch {
        // Object URLs are an optional convenience; never fail the stop for one.
      }
    }
    const stoppedAtMs = this.now();
    const event: RecordingStoppedEvent = {
      blob,
      objectUrl,
      chunkCount: this.chunkIndex,
      bytes: blob.size,
      startedAtMs: this.startedAtMs,
      stoppedAtMs,
      durationMs: Math.max(0, stoppedAtMs - this.startedAtMs),
      streamId: this.streamId,
      label: this.label,
      kind: this.kind,
    };
    this.state_ = 'idle';
    this.emit('recording:stopped', event);
    this.resolveStop?.(event);
  }
}
