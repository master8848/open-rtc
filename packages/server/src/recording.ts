/**
 * @mbsks/openrtc-server — recording byte storage.
 *
 * Recording *sessions* (metadata) live in the `Store`; the media *bytes*
 * (MediaRecorder `.webm` chunks, SFU egress segments, ...) live in a
 * `RecordingStorage`. Two implementations ship:
 *
 *  - `DiskRecordingStorage` — local directory, zero dependencies;
 *  - `S3RecordingStorage` — any S3-compatible object store (AWS S3,
 *    MinIO, R2, GCS XML API, ...) via a minimal SigV4 `fetch` client
 *    (`src/aws-sigv4.ts`) — no AWS SDK dependency.
 *
 * Chunk model: a session is an ordered list of chunks (`index` 0..n-1).
 * `finalize` writes a manifest so `getStream` can reassemble the file.
 */

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { signV4 } from './aws-sigv4.ts';
import { errors } from './errors.ts';

/** Ordered byte storage for one recording session. */
export interface RecordingStorage {
  /** Append one chunk (index is client-supplied, 0-based). */
  saveChunk(sessionId: string, chunk: Buffer, index: number): Promise<void>;
  /** Seal the session; returns byte/chunk totals. */
  finalize(sessionId: string): Promise<{ chunks: number; bytes: number }>;
  /** Stream the concatenated chunks in order. */
  getStream(sessionId: string): Promise<Readable>;
  /** Remove a session's bytes (optional; used by cleanup tooling). */
  delete?(sessionId: string): Promise<void>;
}

export interface FinalizeManifest {
  sessionId: string;
  chunks: number;
  bytes: number;
  finalizedAt: number;
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

export interface DiskRecordingStorageOptions {
  /** Root directory; one subdirectory per session. */
  dir: string;
}

/** Local-filesystem recording storage: `dir/<sessionId>/chunk-<index>` + manifest. */
export class DiskRecordingStorage implements RecordingStorage {
  private readonly dir: string;

  constructor(opts: DiskRecordingStorageOptions) {
    this.dir = opts.dir;
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.dir, safeSegment(sessionId));
  }

  async saveChunk(sessionId: string, chunk: Buffer, index: number): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(chunkPath(dir, index), chunk);
  }

  async finalize(sessionId: string): Promise<{ chunks: number; bytes: number }> {
    const dir = this.sessionDir(sessionId);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      throw errors.recordingStorageError(`No chunks stored for recording ${sessionId}`);
    }
    const chunkEntries = entries.filter((e) => e.startsWith('chunk-'));
    const bytes = await chunkEntries.reduce(async (accP, e) => {
      const acc = await accP;
      const st = await fs.stat(path.join(dir, e));
      return acc + st.size;
    }, Promise.resolve(0));
    const manifest: FinalizeManifest = {
      sessionId,
      chunks: chunkEntries.length,
      bytes,
      finalizedAt: Date.now(),
    };
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { chunks: manifest.chunks, bytes: manifest.bytes };
  }

  async getStream(sessionId: string): Promise<Readable> {
    const dir = this.sessionDir(sessionId);
    const manifest = await readManifest(dir, sessionId);
    const streams = await Promise.all(
      range(manifest.chunks).map(async (i) => {
        const p = chunkPath(dir, i);
        try {
          await fs.access(p);
        } catch {
          throw errors.recordingStorageError(`Missing chunk ${i} for recording ${sessionId}`);
        }
        return createReadStream(p);
      }),
    );
    return Readable.from(
      (async function* () {
        for (const s of streams) {
          yield* s;
        }
      })(),
    );
  }

  async delete(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}

function chunkPath(dir: string, index: number): string {
  return path.join(dir, `chunk-${String(index).padStart(6, '0')}`);
}

async function readManifest(dir: string, sessionId: string): Promise<FinalizeManifest> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as FinalizeManifest;
  } catch {
    throw errors.recordingStorageError(`Recording ${sessionId} is not finalized`);
  }
}

// ---------------------------------------------------------------------------
// S3 (fetch + SigV4, no AWS SDK)
// ---------------------------------------------------------------------------

export interface S3RecordingStorageOptions {
  /** e.g. `https://s3.us-east-1.amazonaws.com` or a MinIO/R2 endpoint. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional object-key prefix, e.g. `recordings/`. */
  prefix?: string;
  /** Path-style URLs (`endpoint/bucket/key`) — required by MinIO; S3 default is virtual-host style. */
  forcePathStyle?: boolean;
  /** Optional custom fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** S3-compatible object storage via a minimal SigV4 `fetch` client. */
export class S3RecordingStorage implements RecordingStorage {
  private readonly opts: Required<
    Pick<
      S3RecordingStorageOptions,
      'endpoint' | 'bucket' | 'region' | 'accessKeyId' | 'secretAccessKey'
    >
  > &
    Pick<S3RecordingStorageOptions, 'prefix' | 'forcePathStyle' | 'fetchImpl'>;

  constructor(opts: S3RecordingStorageOptions) {
    this.opts = {
      endpoint: opts.endpoint.replace(/\/$/, ''),
      bucket: opts.bucket,
      region: opts.region,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      prefix: opts.prefix,
      forcePathStyle: opts.forcePathStyle ?? false,
      fetchImpl: opts.fetchImpl ?? fetch,
    };
  }

  /** Object key for a chunk / manifest. */
  keyFor(sessionId: string, kind: 'chunk' | 'manifest', index?: number): string {
    const base = [this.opts.prefix, safeSegment(sessionId)].filter(Boolean).join('/');
    return kind === 'manifest'
      ? `${base}/manifest.json`
      : `${base}/chunk-${String(index).padStart(6, '0')}`;
  }

  private objectUrl(key: string): string {
    const { endpoint, bucket, forcePathStyle } = this.opts;
    return forcePathStyle
      ? `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(uriEncodeKey).join('/')}`
      : `${endpoint}/${key.split('/').map(uriEncodeKey).join('/')}`;
  }

  async saveChunk(sessionId: string, chunk: Buffer, index: number): Promise<void> {
    const key = this.keyFor(sessionId, 'chunk', index);
    const { headers } = signV4({
      method: 'PUT',
      url: this.objectUrl(key),
      body: chunk,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.opts.region,
      service: 's3',
      headers: { 'content-type': 'application/octet-stream' },
    });
    const res = await this.opts.fetchImpl!(this.objectUrl(key), {
      method: 'PUT',
      headers,
      body: new Uint8Array(chunk),
    });
    if (!res.ok) {
      throw errors.recordingStorageError(
        `S3 put failed (${res.status}) for ${key}`,
        await res.text(),
      );
    }
  }

  async finalize(sessionId: string): Promise<{ chunks: number; bytes: number }> {
    // Discover chunk count by HEAD-requesting until we miss (bounded).
    let chunks = 0;
    let bytes = 0;
    for (let i = 0; i < 10_000; i++) {
      const key = this.keyFor(sessionId, 'chunk', i);
      const res = await this.head(key);
      if (!res.ok) break;
      chunks++;
      const len = Number(res.headers.get('content-length') ?? 0);
      bytes += Number.isFinite(len) ? len : 0;
    }
    if (chunks === 0) {
      throw errors.recordingStorageError(`No chunks stored for recording ${sessionId}`);
    }
    const manifest: FinalizeManifest = { sessionId, chunks, bytes, finalizedAt: Date.now() };
    const key = this.keyFor(sessionId, 'manifest');
    const { headers } = signV4({
      method: 'PUT',
      url: this.objectUrl(key),
      body: Buffer.from(JSON.stringify(manifest)),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.opts.region,
      service: 's3',
      headers: { 'content-type': 'application/json' },
    });
    const res = await this.opts.fetchImpl!(this.objectUrl(key), {
      method: 'PUT',
      headers,
      body: JSON.stringify(manifest),
    });
    if (!res.ok) {
      throw errors.recordingStorageError(
        `S3 manifest put failed (${res.status})`,
        await res.text(),
      );
    }
    return { chunks, bytes };
  }

  private async head(key: string): Promise<Response> {
    const { headers } = signV4({
      method: 'HEAD',
      url: this.objectUrl(key),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.opts.region,
      service: 's3',
    });
    return this.opts.fetchImpl!(this.objectUrl(key), { method: 'HEAD', headers });
  }

  async getStream(sessionId: string): Promise<Readable> {
    const key = this.keyFor(sessionId, 'manifest');
    const res = await this.get(key);
    if (!res.ok)
      throw errors.recordingStorageError(`S3 manifest missing (${res.status}) for ${sessionId}`);
    const manifest = (await res.json()) as FinalizeManifest;
    return Readable.from(this.chunkStream(sessionId, manifest));
  }

  private async *chunkStream(
    sessionId: string,
    manifest: FinalizeManifest,
  ): AsyncGenerator<Buffer> {
    for (let i = 0; i < manifest.chunks; i++) {
      const chunkRes = await this.get(this.keyFor(sessionId, 'chunk', i));
      if (!chunkRes.ok) {
        throw errors.recordingStorageError(
          `S3 chunk ${i} missing (${chunkRes.status}) for ${sessionId}`,
        );
      }
      yield Buffer.from(await chunkRes.arrayBuffer());
    }
  }

  private async get(key: string): Promise<Response> {
    const { headers } = signV4({
      method: 'GET',
      url: this.objectUrl(key),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.opts.region,
      service: 's3',
    });
    return this.opts.fetchImpl!(this.objectUrl(key), { method: 'GET', headers });
  }

  async delete(sessionId: string): Promise<void> {
    // Best-effort: delete manifest + chunks we can find (bounded scan).
    await this.del(this.keyFor(sessionId, 'manifest'));
    for (let i = 0; i < 10_000; i++) {
      const key = this.keyFor(sessionId, 'chunk', i);
      const res = await this.head(key);
      if (!res.ok) break;
      await this.del(key);
    }
  }

  private async del(key: string): Promise<void> {
    const { headers } = signV4({
      method: 'DELETE',
      url: this.objectUrl(key),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.opts.region,
      service: 's3',
    });
    await this.opts.fetchImpl!(this.objectUrl(key), { method: 'DELETE', headers });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Keep session ids safe as filesystem segments / object keys. */
function safeSegment(sessionId: string): string {
  const cleaned = sessionId.replace(/[^\w.-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw errors.invalidRequest(`Unsafe recording session id: ${sessionId}`);
  }
  return cleaned;
}

function uriEncodeKey(segment: string): string {
  return encodeURIComponent(segment);
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
