/**
 * `CompositeRecordingHook` — records the whole call: the local tracks AND the
 * remote participants' tracks (audio/video/screen) into separate
 * `MediaRecorder`s that share ONE timeline.
 *
 * Every stream gets its own `MediaRecorderRecordingHook`; all of them are
 * started with the same `timeOrigin` (captured from the shared `now` clock),
 * so `recording:blob-chunk` events from different streams carry comparable
 * `timestampMs` values. Chunks are tagged with `streamId` (`'local'`,
 * `'remote:<participantId>'`) and `kind` (`'local' | 'remote'`).
 *
 * ```ts
 * const hook = new CompositeRecordingHook();
 * hook.on('recording:blob-chunk', (chunk) => upload(chunk));
 * await hook.start({ localStream, remoteStreams: [{ participantId, stream }] });
 * // ...
 * const report = await hook.stop(); // report.results: one entry per stream
 * ```
 */
import { TypedEmitter } from '../events.ts';
import type { MediaRecorderConstructor } from './media-recorder-recording-hook.ts';
import { MediaRecorderRecordingHook } from './media-recorder-recording-hook.ts';
import type {
  RecordingErrorEvent,
  RecordingHook,
  RecordingHookEventMap,
  RecordingMediaMode,
  RecordingSaveTarget,
  RecordingStartedEvent,
  RecordingStoppedEvent,
  RecordingState,
  RecordingStreamKind,
} from './recording-hook.ts';
import { RecordingUnavailableError } from './recording-hook.ts';

/** A remote participant's stream to record. */
export interface RecordingRemoteStream {
  participantId: string;
  stream: MediaStream;
  /** Optional label (defaults to participantId). */
  label?: string;
}

/** Full control over one recorded stream. */
export interface CompositeRecordingStreamOptions {
  /** Stable stream id reported on events ('local', 'remote:<id>', ...). */
  id: string;
  stream: MediaStream;
  kind?: RecordingStreamKind;
  label?: string;
  /** Per-stream MIME candidates (default: shared default probing order). */
  mimeTypes?: readonly string[];
  videoBitsPerSecond?: number;
  /** Per-stream timeslice (default: shared timesliceMs). */
  timesliceMs?: number;
}

export interface CompositeRecordingOptions {
  /** Local composed stream (camera + mic tracks). Recorded as 'local'. */
  localStream?: MediaStream | null;
  /** Remote participant streams (recorded as 'remote:<participantId>'). */
  remoteStreams?: Array<RecordingRemoteStream | MediaStream> | null;
  /** Full stream control; when set, `localStream`/`remoteStreams` are ignored. */
  streams?: CompositeRecordingStreamOptions[];
  /** Media content mode: 'audio+video' (default) vs 'audio-only' (video tracks stripped). */
  mediaMode?: RecordingMediaMode;
  /** Save target reservation: 'server' (default) stores via uploader, 'browser' future local download. */
  saveTarget?: RecordingSaveTarget;
  /** `dataavailable` timeslice in ms for every recorder (default 1000). */
  timesliceMs?: number;
  /** Create in-memory object URLs for each final stream Blob. */
  createObjectUrl?: boolean;
  /** Shared timeline clock (default Date.now). */
  now?: () => number;
  /** MediaRecorder constructor override (tests inject fakes). */
  mediaRecorderCtor?: MediaRecorderConstructor | null;
  /** Explicit support override (default: platform detection). */
  supported?: boolean;
}

export interface RecordingStreamInfo {
  streamId: string;
  label?: string;
  kind: RecordingStreamKind;
  mimeType: string;
}

export interface CompositeRecordingStartedEvent extends RecordingStartedEvent {
  /** One entry per started recorder. */
  streams: RecordingStreamInfo[];
}

function filterStreamForMediaMode(stream: MediaStream, mediaMode?: RecordingMediaMode): MediaStream {
  if (mediaMode !== 'audio-only') return stream;
  // Create a new stream containing only audio tracks; video tracks are dropped.
  const audioTracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
  // Preserve original stream when no filtering needed (no video or no audio helper)
  const videoTracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
  if (videoTracks.length === 0) return stream;
  if (audioTracks.length === 0) {
    // Audio-only requested but source has no audio – return empty audio stream
    // to make the lack explicit rather than silently recording video.
    return new MediaStream([]);
  }
  return new MediaStream(audioTracks);
}

export interface CompositeRecordingStoppedEvent extends RecordingStoppedEvent {
  /** Per-stream stop reports (blob, chunkCount, bytes, ...). */
  results: RecordingStoppedEvent[];
}

function detectMediaRecorderSupport(ctor?: MediaRecorderConstructor | null): boolean {
  const candidate = ctor ?? (typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined);
  return typeof candidate === 'function';
}

export class CompositeRecordingHook
  extends TypedEmitter<RecordingHookEventMap>
  implements RecordingHook
{
  private readonly hooks = new Map<string, MediaRecorderRecordingHook>();
  private readonly timesliceMs: number;
  private readonly createObjectUrl: boolean;
  private readonly now: () => number;
  private readonly mediaRecorderCtor?: MediaRecorderConstructor;
  private readonly supported: boolean;
  private remoteSeq = 0;
  /** Shared timeline origin captured when the composite started. */
  private origin = 0;
  private readonly defaultMediaMode: RecordingMediaMode;
  private readonly defaultSaveTarget: RecordingSaveTarget;
  private activeMediaMode: RecordingMediaMode = 'audio+video';
  private activeSaveTarget: RecordingSaveTarget = 'server';

  constructor(options: CompositeRecordingOptions = {}) {
    super();
    this.timesliceMs = options.timesliceMs ?? 1000;
    this.createObjectUrl = options.createObjectUrl ?? false;
    this.now = options.now ?? (() => Date.now());
    this.mediaRecorderCtor = options.mediaRecorderCtor ?? undefined;
    this.supported = options.supported ?? detectMediaRecorderSupport(this.mediaRecorderCtor);
    this.defaultMediaMode = options.mediaMode ?? 'audio+video';
    this.defaultSaveTarget = options.saveTarget ?? 'server';
  }

  getState(): RecordingState {
    if (!this.supported) return 'unavailable';
    const states = new Set<RecordingState>();
    for (const hook of this.hooks.values()) states.add(hook.getState());
    if (states.size === 0) return 'idle';
    if (states.has('error')) return 'error';
    if (states.has('stopping')) return 'stopping';
    if (states.has('starting')) return 'starting';
    if (states.has('paused')) return 'paused';
    if (states.has('recording')) return 'recording';
    return 'idle';
  }

  async start(options: CompositeRecordingOptions = {}): Promise<CompositeRecordingStartedEvent> {
    const state = this.getState();
    if (
      state === 'recording' ||
      state === 'paused' ||
      state === 'starting' ||
      state === 'stopping'
    ) {
      throw new Error(`CompositeRecordingHook: cannot start in state '${state}'`);
    }
    if (!this.supported || !this.mediaRecorderCtor) {
      throw new RecordingUnavailableError();
    }

    const effectiveMediaMode = options.mediaMode ?? this.defaultMediaMode;
    const effectiveSaveTarget = options.saveTarget ?? this.defaultSaveTarget;
    this.activeMediaMode = effectiveMediaMode;
    this.activeSaveTarget = effectiveSaveTarget;
    const descriptors = this.buildDescriptors(options, effectiveMediaMode);
    if (descriptors.length === 0) {
      throw new Error('CompositeRecordingHook: no streams to record');
    }

    const timeOrigin = this.now();
    this.origin = timeOrigin;
    const started: RecordingStreamInfo[] = [];
    const startedHooks: MediaRecorderRecordingHook[] = [];
    try {
      for (const descriptor of descriptors) {
        const hook = new MediaRecorderRecordingHook({
          stream: descriptor.stream,
          streamId: descriptor.id,
          label: descriptor.label,
          kind: descriptor.kind,
          mimeTypes: descriptor.mimeTypes,
          timesliceMs: descriptor.timesliceMs ?? this.timesliceMs,
          createObjectUrl: this.createObjectUrl,
          videoBitsPerSecond: descriptor.videoBitsPerSecond,
          now: this.now,
          mediaRecorderCtor: this.mediaRecorderCtor,
          supported: this.supported,
        });
        hook.on('recording:blob-chunk', (chunk) => this.emit('recording:blob-chunk', chunk));
        hook.on('recording:error', (event: RecordingErrorEvent) =>
          this.emit('recording:error', event),
        );
        this.hooks.set(descriptor.id, hook);
        const startedEvent = await hook.start({ timeOrigin });
        startedHooks.push(hook);
        started.push({
          streamId: descriptor.id,
          label: descriptor.label,
          kind: descriptor.kind ?? 'remote',
          mimeType: startedEvent.mimeType ?? '',
        });
      }
    } catch (err) {
      // Don't leak half-started recorders.
      await Promise.allSettled(startedHooks.map((hook) => hook.stop()));
      this.hooks.clear();
      throw err;
    }

    const event: CompositeRecordingStartedEvent = { startedAtMs: timeOrigin, streams: started, mediaMode: effectiveMediaMode, saveTarget: effectiveSaveTarget };
    this.emit('recording:started', event);
    return event;
  }

  async stop(): Promise<CompositeRecordingStoppedEvent | undefined> {
    const hooks = [...this.hooks.values()];
    if (hooks.length === 0) return undefined;
    const results = (
      await Promise.all(
        hooks.map((hook) =>
          hook.stop().catch((err) => {
            this.emit('recording:error', {
              error: err instanceof Error ? err : new Error(String(err)),
              streamId: undefined,
              code: 'recorder',
            });
            return undefined;
          }),
        ),
      )
    ).filter((result): result is RecordingStoppedEvent => result !== undefined);
    this.hooks.clear();
    if (results.length === 0) return undefined;

    const stoppedAtMs = this.now();
    const event: CompositeRecordingStoppedEvent = {
      results,
      chunkCount: results.reduce((sum, r) => sum + r.chunkCount, 0),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
      durationMs: Math.max(0, ...results.map((r) => r.durationMs)),
      startedAtMs: this.origin,
      stoppedAtMs,
      mediaMode: this.activeMediaMode,
      saveTarget: this.activeSaveTarget,
    };
    this.emit('recording:stopped', event);
    return event;
  }

  pause(): void {
    const state = this.getState();
    if (state !== 'recording') {
      throw new Error(`CompositeRecordingHook: cannot pause in state '${state}'`);
    }
    for (const hook of this.hooks.values()) {
      try {
        hook.pause();
      } catch {
        // A stream that already errored out simply stays put.
      }
    }
  }

  resume(): void {
    const state = this.getState();
    if (state !== 'paused') {
      throw new Error(`CompositeRecordingHook: cannot resume in state '${state}'`);
    }
    for (const hook of this.hooks.values()) {
      try {
        hook.resume();
      } catch {
        // See pause().
      }
    }
  }

  /**
   * Start recording an additional remote stream mid-call. The new recorder
   * joins the same timeline (`timeOrigin` captured at composite start), so its
   * chunk timestamps line up with the streams recorded from the beginning.
   */
  async addRemoteStream(
    stream: MediaStream,
    participantId?: string,
  ): Promise<RecordingStartedEvent> {
    const state = this.getState();
    if (state !== 'recording') {
      throw new Error(
        `CompositeRecordingHook: can only add a stream while recording (state '${state}')`,
      );
    }
    const id = `remote:${participantId ?? stream.id ?? `stream-${this.remoteSeq++}`}`;
    const filtered = filterStreamForMediaMode(stream, this.defaultMediaMode);
    const hook = new MediaRecorderRecordingHook({
      stream: filtered,
      streamId: id,
      label: participantId,
      kind: 'remote',
      timesliceMs: this.timesliceMs,
      createObjectUrl: this.createObjectUrl,
      now: this.now,
      mediaRecorderCtor: this.mediaRecorderCtor,
      supported: this.supported,
    });
    hook.on('recording:blob-chunk', (chunk) => this.emit('recording:blob-chunk', chunk));
    hook.on('recording:error', (event: RecordingErrorEvent) => this.emit('recording:error', event));
    this.hooks.set(id, hook);
    return hook.start({ timeOrigin: this.origin });
  }

  /** Stop and remove one recorded stream (e.g. a participant left). */
  async removeRemoteStream(streamId: string): Promise<RecordingStoppedEvent | undefined> {
    const hook = this.hooks.get(streamId);
    if (!hook) return undefined;
    this.hooks.delete(streamId);
    return hook.stop();
  }

  /** Stream ids currently being recorded. */
  getStreamIds(): string[] {
    return [...this.hooks.keys()];
  }

  // ------------------------------------------------------------- internals

  private buildDescriptors(options: CompositeRecordingOptions, mediaMode?: RecordingMediaMode): CompositeRecordingStreamOptions[] {
    const effectiveMode = mediaMode ?? options.mediaMode ?? this.defaultMediaMode;
    if (options.streams && options.streams.length > 0) {
      return options.streams.map((s) => ({ ...s, stream: filterStreamForMediaMode(s.stream, effectiveMode) }));
    }
    const descriptors: CompositeRecordingStreamOptions[] = [];
    if (options.localStream) {
      descriptors.push({
        id: 'local',
        stream: filterStreamForMediaMode(options.localStream, effectiveMode),
        kind: 'local',
        label: 'Local',
      });
    }
    for (const remote of options.remoteStreams ?? []) {
      if ('participantId' in remote) {
        descriptors.push({
          id: `remote:${remote.participantId}`,
          stream: filterStreamForMediaMode(remote.stream, effectiveMode),
          kind: 'remote',
          label: remote.label ?? remote.participantId,
        });
      } else {
        const stream = remote as MediaStream;
        descriptors.push({
          id: `remote:${stream.id || `stream-${this.remoteSeq++}`}`,
          stream: filterStreamForMediaMode(stream, effectiveMode),
          kind: 'remote',
          label: 'Remote',
        });
      }
    }
    return descriptors;
  }
}
