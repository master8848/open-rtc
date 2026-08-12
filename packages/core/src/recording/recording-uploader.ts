/**
 * Server-upload integration for recordings (docs/architecture.md D6).
 *
 * `RecordingUploader` is the engine-agnostic contract: the room recording
 * facade pushes each `recording:blob-chunk` with `uploadChunk(...)` and
 * reports the final summary with `finalize(...)`.
 *
 * `FetchRecordingUploader` is a dependency-light implementation that POSTs
 * chunks to the vidcall server's recording endpoint. The endpoint URL is
 * configurable (base URL + `pathFor` builder) and the implementation uses only
 * the platform `fetch` — there is no dependency on the server package.
 */
import type { RecordingChunk, RecordingStoppedEvent } from './recording-hook.ts';

/** Server-side recording sink contract. */
export interface RecordingUploader {
  /** Push one timeslice chunk. `chunk.index` is monotonic per session. */
  uploadChunk(roomId: string, sessionId: string, chunk: RecordingChunk): Promise<void>;
  /** Report the finished recording (chunk counts, per-stream summary). */
  finalize(roomId: string, sessionId: string, result: RecordingStoppedEvent): Promise<void>;
}

/** Thrown when a chunk upload or finalize report fails. */
export class RecordingUploadError extends Error {
  readonly code = 'RECORDING_UPLOAD_ERROR' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RecordingUploadError';
  }
}

/** Minimal fetch surface the uploader needs (test-friendly, host-agnostic). */
export interface RecordingFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Blob | string;
}

export interface RecordingFetchResponse {
  ok: boolean;
  status: number;
}

export type RecordingFetch = (
  url: string,
  init?: RecordingFetchInit,
) => Promise<RecordingFetchResponse>;

export interface FetchRecordingUploaderOptions {
  /**
   * Base URL of the vidcall server (e.g. 'https://api.example.com'). The
   * recordings path is appended: `<endpoint>/rooms/<roomId>/sessions/<sessionId>/recordings/chunks`.
   */
  endpoint: string;
  /** Extra headers merged into every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * fetch implementation (default: global fetch). Pass `null` to force the
   * "no fetch available" path (e.g. tests); pass a mock for tests.
   */
  fetchImpl?: RecordingFetch | null;
  /** URL path builder; default `rooms/<roomId>/sessions/<sessionId>/recordings`. */
  pathFor?: (roomId: string, sessionId: string) => string;
}

function defaultFetch(): RecordingFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === 'function' ? (candidate as RecordingFetch) : undefined;
}

export class FetchRecordingUploader implements RecordingUploader {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl?: RecordingFetch;
  private readonly pathFor: (roomId: string, sessionId: string) => string;

  constructor(options: FetchRecordingUploaderOptions) {
    if (!options.endpoint || typeof options.endpoint !== 'string') {
      throw new TypeError('FetchRecordingUploader: endpoint is required');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl === null ? undefined : (options.fetchImpl ?? defaultFetch());
    this.pathFor =
      options.pathFor ??
      ((roomId, sessionId) =>
        `rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}/recordings`);
  }

  async uploadChunk(roomId: string, sessionId: string, chunk: RecordingChunk): Promise<void> {
    const url = this.urlFor(roomId, sessionId, 'chunks');
    const response = await this.perform(url, {
      method: 'POST',
      headers: {
        'Content-Type': chunk.mimeType || 'application/octet-stream',
        'X-Recording-Chunk-Index': String(chunk.index),
        'X-Recording-Stream-Id': chunk.streamId ?? '',
        'X-Recording-Timestamp-Ms': String(chunk.timestampMs),
        ...this.headers,
      },
      body: chunk.blob,
    });
    if (!response.ok) {
      throw new RecordingUploadError(`uploadChunk: HTTP ${response.status} for ${url}`);
    }
  }

  async finalize(roomId: string, sessionId: string, result: RecordingStoppedEvent): Promise<void> {
    const url = this.urlFor(roomId, sessionId, 'finalize');
    // Composite hooks attach a per-stream `results` array to the stopped event.
    const results = (result as { results?: RecordingStoppedEvent[] }).results ?? [result];
    const streams = results.map((r) => ({
      streamId: r.streamId ?? null,
      label: r.label ?? null,
      kind: r.kind ?? null,
      mimeType: r.blob?.type ?? null,
      chunkCount: r.chunkCount,
      bytes: r.bytes,
      durationMs: r.durationMs,
    }));
    const response = await this.perform(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({
        roomId,
        sessionId,
        chunkCount: result.chunkCount,
        bytes: result.bytes,
        startedAtMs: result.startedAtMs,
        stoppedAtMs: result.stoppedAtMs,
        durationMs: result.durationMs,
        streams,
      }),
    });
    if (!response.ok) {
      throw new RecordingUploadError(`finalize: HTTP ${response.status} for ${url}`);
    }
  }

  private async perform(url: string, init: RecordingFetchInit): Promise<RecordingFetchResponse> {
    if (!this.fetchImpl) {
      throw new RecordingUploadError('fetch is not available in this environment');
    }
    return this.fetchImpl(url, init);
  }

  private urlFor(roomId: string, sessionId: string, action: string): string {
    const path = this.pathFor(roomId, sessionId).replace(/^\/+/, '');
    return `${this.endpoint}/${path}/${action}`;
  }
}
