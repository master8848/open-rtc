/**
 * `RoomRecordingFacade` — the `room.recording` surface (docs/architecture.md D6).
 *
 * Wires a `CompositeRecordingHook` (local + remote streams on one timeline) to
 * an optional `RecordingUploader`: every `recording:blob-chunk` is pushed with
 * `uploadChunk(roomId, sessionId, chunk)` and the final report with
 * `finalize(...)`. All hook events are re-emitted on the facade (and, through
 * the Room wiring, on the room itself).
 *
 * ```ts
 * room.recording.on('recording:blob-chunk', (chunk) => { ... });
 * await room.recording.startRecording({ localStream, remoteStreams });
 * // ... some time later
 * await room.recording.stopRecording();
 * ```
 *
 * Upload failures are non-fatal: they surface as `recording:error` events
 * (with `code: 'upload'`) and never abort the local recording.
 */
import { TypedEmitter } from '../events.ts';
import type { MediaRecorderConstructor } from './media-recorder-recording-hook.ts';
import type { RecordingRemoteStream } from './composite-recording-hook.ts';
import { CompositeRecordingHook } from './composite-recording-hook.ts';
import type {
  RecordingChunk,
  RecordingHookEventMap,
  RecordingStartedEvent,
  RecordingStoppedEvent,
  RecordingState,
} from './recording-hook.ts';
import type { RecordingUploader } from './recording-uploader.ts';

export interface RoomRecordingOptions {
  /** Local composed stream (camera + mic tracks) to record as 'local'. */
  localStream?: MediaStream;
  /** Remote participant streams to record as 'remote:<participantId>'. */
  remoteStreams?: Array<RecordingRemoteStream | MediaStream>;
  /** Uploader for this session (default: the facade's configured uploader). */
  uploader?: RecordingUploader;
  /** `dataavailable` timeslice in ms (default 1000). */
  timesliceMs?: number;
  /** Create an in-memory object URL for each final stream Blob. */
  createObjectUrl?: boolean;
  /** Shared timeline clock (default Date.now). */
  now?: () => number;
}

export interface RoomRecordingFacadeOptions {
  roomId: string;
  sessionId: string;
  /** Uploader used when startRecording doesn't pass one. */
  uploader?: RecordingUploader;
  timesliceMs?: number;
  createObjectUrl?: boolean;
  now?: () => number;
  /** MediaRecorder constructor override (tests inject fakes). */
  mediaRecorderCtor?: MediaRecorderConstructor | null;
  debug?: (message: string, data?: unknown) => void;
}

export class RoomRecordingFacade extends TypedEmitter<RecordingHookEventMap> {
  private readonly roomId: string;
  private readonly sessionId: string;
  private readonly defaultUploader?: RecordingUploader;
  private readonly debug: (message: string, data?: unknown) => void;
  private readonly hook: CompositeRecordingHook;
  private activeUploader?: RecordingUploader;

  constructor(options: RoomRecordingFacadeOptions) {
    super();
    this.roomId = options.roomId;
    this.sessionId = options.sessionId;
    this.defaultUploader = options.uploader;
    this.debug = options.debug ?? (() => {});
    this.hook = new CompositeRecordingHook({
      timesliceMs: options.timesliceMs,
      createObjectUrl: options.createObjectUrl,
      now: options.now,
      mediaRecorderCtor: options.mediaRecorderCtor,
    });
    this.hook.on('recording:started', (event) => this.emit('recording:started', event));
    this.hook.on('recording:stopped', (event) => {
      this.emit('recording:stopped', event);
      void this.finalizeUpload(event);
    });
    this.hook.on('recording:error', (event) => this.emit('recording:error', event));
    this.hook.on('recording:blob-chunk', (chunk) => {
      this.emit('recording:blob-chunk', chunk);
      void this.uploadChunk(chunk);
    });
  }

  /**
   * Start recording the local and remote streams. Events (started / chunks /
   * stopped / error) flow to the facade and to `room.on('recording:...')`.
   */
  async startRecording(options: RoomRecordingOptions = {}): Promise<RecordingStartedEvent> {
    this.activeUploader = options.uploader ?? this.defaultUploader;
    return this.hook.start({
      localStream: options.localStream,
      remoteStreams: options.remoteStreams,
      timesliceMs: options.timesliceMs,
      createObjectUrl: options.createObjectUrl,
      now: options.now,
    });
  }

  /** Stop all recorders; resolves with the aggregate report (undefined if idle). */
  async stopRecording(): Promise<RecordingStoppedEvent | undefined> {
    return this.hook.stop();
  }

  /** Pause all recorders (uploader unaffected). */
  pause(): void {
    this.hook.pause();
  }

  /** Resume paused recorders. */
  resume(): void {
    this.hook.resume();
  }

  getState(): RecordingState {
    return this.hook.getState();
  }

  /** Start recording an additional remote stream mid-call (same timeline). */
  async addRemoteStream(
    stream: MediaStream,
    participantId?: string,
  ): Promise<RecordingStartedEvent> {
    return this.hook.addRemoteStream(stream, participantId);
  }

  /** Stop + remove one recorded stream. */
  async removeRemoteStream(streamId: string): Promise<RecordingStoppedEvent | undefined> {
    return this.hook.removeRemoteStream(streamId);
  }

  // ------------------------------------------------------------- internals

  private async uploadChunk(chunk: RecordingChunk): Promise<void> {
    const uploader = this.activeUploader ?? this.defaultUploader;
    if (!uploader) return;
    try {
      await uploader.uploadChunk(this.roomId, this.sessionId, chunk);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.debug('recording:upload-failed', error);
      this.emit('recording:error', {
        error,
        code: 'upload',
        streamId: chunk.streamId,
        label: chunk.label,
        kind: chunk.kind,
      });
    }
  }

  private async finalizeUpload(result: RecordingStoppedEvent): Promise<void> {
    const uploader = this.activeUploader ?? this.defaultUploader;
    if (!uploader) return;
    try {
      await uploader.finalize(this.roomId, this.sessionId, result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.debug('recording:finalize-failed', error);
      this.emit('recording:error', { error, code: 'upload' });
    }
  }
}
