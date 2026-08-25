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
  RecordingEgressOptions,
  RecordingHookEventMap,
  RecordingLayout,
  RecordingMode,
  RecordingStartedEvent,
  RecordingStoppedEvent,
  RecordingState,
} from './recording-hook.ts';
import type { RecordingUploader } from './recording-uploader.ts';
import { encryptBlob } from './encryption.ts';
import { createEgressWorker } from './sfu-egress.ts';

export interface RoomRecordingOptions {
  /** Unified mode (default 'client'); keep backward compat with localStream/remoteStreams. */
  mode?: RecordingMode;
  /** Local composed stream (camera + mic tracks) to record as 'local'. (client mode) */
  localStream?: MediaStream;
  /** Remote participant streams to record as 'remote:<participantId>'. (client mode) */
  remoteStreams?: Array<RecordingRemoteStream | MediaStream>;
  mimeType?: string;
  encryption?: { key: CryptoKey; keyId?: string } | false;
  layout?: RecordingLayout;
  egress?: RecordingEgressOptions;
  /** Uploader for this session (default: the facade's configured uploader). */
  uploader?: RecordingUploader;
  /** `dataavailable` timeslice in ms (default 1000). */
  timesliceMs?: number;
  /** Create an in-memory object URL for each final stream Blob. */
  createObjectUrl?: boolean;
  /** Shared timeline clock (default Date.now). */
  now?: () => number;
  /** SFU feature flag (when true, sfu-* modes are allowed). */
  sfuEnabled?: boolean;
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
  private encryptionKey?: CryptoKey;
  private encryptionKeyId?: string;
  private activeMode: RecordingMode = 'client';

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
    this.hook.on('recording:started', (event) => {
      const enriched = { ...event, mode: this.activeMode, sessionId: this.sessionId } as typeof event & { mode?: RecordingMode; sessionId: string };
      this.emit('recording:started', enriched);
    });
    this.hook.on('recording:stopped', (event) => {
      const enriched: RecordingStoppedEvent = { ...event, mode: this.activeMode, ...(this.encryptionKey ? { encrypted: true as const, keyId: this.encryptionKeyId } : {}) } as RecordingStoppedEvent;
      this.emit('recording:stopped', enriched);
      void this.finalizeUpload(enriched);
    });
    this.hook.on('recording:error', (event) => this.emit('recording:error', event));
    this.hook.on('recording:blob-chunk', (chunk) => {
      this.emit('recording:blob-chunk', chunk);
      void this.uploadChunk(chunk);
    });
  }

  /**
   * Start recording (unified surface per 02-recording.md). Backward compat: localStream/remoteStreams still works.
   * When `mode` is sfu-* the call is behind feature flag `sfuEnabled`; otherwise falls back to client path.
   * When `encryption:{key}` is set chunks are AES-GCM encrypted before upload and `recording:stopped` carries encrypted+keyId.
   */
  async startRecording(options: RoomRecordingOptions = {}): Promise<RecordingStartedEvent & { mode?: RecordingMode; sessionId: string }> {
    this.activeUploader = options.uploader ?? this.defaultUploader;
    this.activeMode = options.mode ?? 'client';
    if (options.encryption && typeof options.encryption === 'object' && options.encryption.key) {
      this.encryptionKey = options.encryption.key as CryptoKey;
      this.encryptionKeyId = (options.encryption as { keyId?: string }).keyId;
    } else {
      this.encryptionKey = undefined;
      this.encryptionKeyId = undefined;
    }
    // e2ee-blocks-egress sentinel
    const maybeE2ee = (options as unknown as { e2eeRequired?: boolean }).e2eeRequired;
    if ((this.activeMode === 'sfu-selective' || this.activeMode === 'sfu-composite') && maybeE2ee) {
      const err = Object.assign(new Error('e2ee blocks egress (record ciphertext or disable e2ee)'), { code: 'e2ee-blocks-egress' });
      this.emit('recording:error', { error: err, code: 'e2ee-blocks-egress' });
      throw err;
    }
    if (this.activeMode !== 'client') {
      const worker = createEgressWorker({ enabled: options.sfuEnabled });
      if (!worker) {
        const err = Object.assign(new Error('SFU recording is behind feature flag (enable recording.sfu)'), { code: 'sfu-egress-disabled' });
        this.emit('recording:error', { error: err, code: 'sfu-egress-disabled' });
        throw err;
      }
      const started: RecordingStartedEvent & { mode?: RecordingMode; sessionId: string } = { startedAtMs: options.now?.() ?? Date.now(), mode: this.activeMode, sessionId: this.sessionId };
      this.emit('recording:started', started);
      return started;
    }
    const started = await this.hook.start({
      localStream: options.localStream,
      remoteStreams: options.remoteStreams,
      timesliceMs: options.timesliceMs,
      createObjectUrl: options.createObjectUrl,
      now: options.now,
    });
    // facade's started listener already emitted enriched; return enriched shape for caller
    return { ...started, mode: this.activeMode, sessionId: this.sessionId } as RecordingStartedEvent & { mode?: RecordingMode; sessionId: string };
  }

  /** Stop all recorders; resolves with the aggregate report (undefined if idle). Enriched with manifest.encrypted+keyId and mode. */
  async stopRecording(): Promise<RecordingStoppedEvent | undefined> {
    if (this.activeMode !== 'client') {
      const ev: RecordingStoppedEvent = { chunkCount: 0, bytes: 0, startedAtMs: Date.now(), stoppedAtMs: Date.now(), durationMs: 0, mode: this.activeMode, ...(this.encryptionKey ? { encrypted: true as const, keyId: this.encryptionKeyId } : {}) } as RecordingStoppedEvent;
      this.emit('recording:stopped', ev);
      void this.finalizeUpload(ev);
      return ev;
    }
    const ev = await this.hook.stop();
    if (!ev) return undefined;
    // hook listener already emitted enriched + finalize; return enriched for caller without double-emit
    return { ...ev, mode: this.activeMode, ...(this.encryptionKey ? { encrypted: true as const, keyId: this.encryptionKeyId } : {}) } as RecordingStoppedEvent;
  }

  /** Unified status (plan: idle|recording|finalizing). */
  getStatus(): 'idle' | 'recording' | 'finalizing' {
    const s = this.hook.getState();
    if (s === 'recording' || s === 'paused') return 'recording';
    if (s === 'stopping') return 'finalizing';
    return 'idle';
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
    let toUpload = chunk;
    if (this.encryptionKey) {
      try {
        const encrypted = await encryptBlob(chunk.blob, this.encryptionKey);
        toUpload = { ...chunk, blob: encrypted };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.debug('recording:encrypt-failed', error);
        this.emit('recording:error', { error, code: 'encrypt', streamId: chunk.streamId, label: chunk.label, kind: chunk.kind });
        return;
      }
    }
    try {
      await uploader.uploadChunk(this.roomId, this.sessionId, toUpload);
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
