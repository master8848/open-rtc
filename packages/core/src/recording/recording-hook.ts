/**
 * Recording hooks (docs/architecture.md D6, docs/research/webrtc-js.md §6).
 *
 * A `RecordingHook` records one or more `MediaStream`s through the platform
 * `MediaRecorder` (or, in the future, an SFU egress) and surfaces typed
 * events:
 *
 *  - `recording:started` — recording began (MIME type, stream info),
 *  - `recording:blob-chunk` — one timeslice of encoded bytes,
 *  - `recording:stopped` — recording ended (complete `Blob`, byte counts),
 *  - `recording:error` — recorder/upload failure.
 *
 * Implementations are dependency-light: they use only platform APIs
 * (`MediaRecorder`, `Blob`, `URL`) and the in-workspace `TypedEmitter`.
 */
import type { TypedEmitter } from '../events.ts';

/** Hook lifecycle state. */
export type RecordingState =
  'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error' | 'unavailable';

/** Which side of the call a recorded stream came from. */
export type RecordingStreamKind = 'local' | 'remote';

/** Emitted when a recording (or one of its streams) starts. */
export interface RecordingStartedEvent {
  /** Hook-clock ms when the recording started (see the `now` option). */
  startedAtMs: number;
  /** Encoded MIME type in use ('' = platform default). */
  mimeType?: string;
  /** Stable stream id ('local', 'remote:<participantId>', ...). */
  streamId?: string;
  /** Human-readable stream label (e.g. participant display name). */
  label?: string;
  kind?: RecordingStreamKind;
}

/** One timeslice of encoded media from a recorder. */
export interface RecordingChunk {
  /** 0-based chunk index within the recording session. */
  index: number;
  /** Encoded bytes for this timeslice. */
  blob: Blob;
  /** Chunk MIME type ('' if unknown). */
  mimeType: string;
  /** Milliseconds since the common timeline origin (`now() - timeOrigin`). */
  timestampMs: number;
  streamId?: string;
  label?: string;
  kind?: RecordingStreamKind;
}

/** Emitted when a recording (or one of its streams) stops. */
export interface RecordingStoppedEvent {
  /** Complete recording as a single Blob (single-stream hooks). */
  blob?: Blob;
  /** In-memory object URL for `blob`, when `createObjectUrl` was set. */
  objectUrl?: string;
  /** Number of `recording:blob-chunk` events emitted this session. */
  chunkCount: number;
  /** Total encoded bytes across all chunks. */
  bytes: number;
  startedAtMs: number;
  stoppedAtMs: number;
  durationMs: number;
  streamId?: string;
  label?: string;
  kind?: RecordingStreamKind;
}

/** Emitted when a recorder or upload fails. */
export interface RecordingErrorEvent {
  error: Error;
  streamId?: string;
  label?: string;
  kind?: RecordingStreamKind;
  /** Error category: 'recorder' | 'upload'. */
  code?: string;
}

export type RecordingHookEventMap = {
  'recording:started': [RecordingStartedEvent];
  'recording:stopped': [RecordingStoppedEvent];
  'recording:error': [RecordingErrorEvent];
  'recording:blob-chunk': [RecordingChunk];
};

/** Options accepted by `RecordingHook.start()` implementations. */
export interface RecordingStartOptions {
  /**
   * Common-timeline anchor: chunk timestamps are `now() - timeOrigin`.
   * Composite hooks pass one shared anchor to every stream recorder so chunks
   * from different streams line up on the same timeline.
   */
  timeOrigin?: number;
}

/** Engine-agnostic recording hook contract (D6). */
export interface RecordingHook extends TypedEmitter<RecordingHookEventMap> {
  /** Begin recording; resolves once the recorder(s) are running. */
  start(): Promise<RecordingStartedEvent>;
  /** Stop recording; resolves with the final report (undefined if idle). */
  stop(): Promise<RecordingStoppedEvent | undefined>;
  /** Pause all active recorders. */
  pause(): void;
  /** Resume paused recorders. */
  resume(): void;
  getState(): RecordingState;
}

/** Thrown by `start()` when the platform has no MediaRecorder. */
export class RecordingUnavailableError extends Error {
  readonly code = 'RECORDING_UNAVAILABLE' as const;

  constructor(message = 'MediaRecorder is not available in this environment') {
    super(message);
    this.name = 'RecordingUnavailableError';
  }
}
