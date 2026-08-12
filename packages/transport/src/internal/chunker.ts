/**
 * Chunker — split payloads that exceed a backend's frame cap into
 * byte-aligned chunks and reassemble them on the far side.
 *
 * PostgreSQL's NOTIFY caps payloads at 8000 bytes in the default config, so
 * the postgres adapter ships chunks of <= 7000 bytes (safety margin). Every
 * other adapter's cap is far above SDP/ICE sizes; the chunker is still wired
 * in generically so any adapter can opt in via options.
 */

/** Wire shape of one chunk frame. */
export interface ChunkFrame {
  /** marker: always 'chunk'. */
  k: 'chunk';
  /** chunk group id — identical for every part of one message. */
  id: string;
  /** zero-based part index. */
  i: number;
  /** total number of parts. */
  n: number;
  /** this part of the serialized JSON (byte-aligned). */
  d: string;
}

const MARKER: ChunkFrame['k'] = 'chunk';

/**
 * Split a string into parts of at most maxBytes bytes each, never splitting
 * a multi-byte UTF-8 code point. Parts may exceed maxBytes by up to one code
 * point (<= 4 bytes) so that no character is ever torn.
 */
export function splitUtf8(input: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new Error('chunker: maxBytes must be > 0');
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of input) {
    const chBytes = encoder.encode(ch).length;
    if (currentBytes + chBytes > maxBytes && current.length > 0) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  parts.push(current);
  return parts;
}

/** Encode a serialized JSON payload into chunk frames. */
export function encodeChunks(json: string, maxBytes: number, chunkId?: string): ChunkFrame[] {
  const parts = splitUtf8(json, maxBytes);
  const id = chunkId ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return parts.map((d, i) => ({ k: MARKER, id, i, n: parts.length, d }));
}

/** True when the parsed frame is a chunk frame. */
export function isChunkFrame(x: unknown): x is ChunkFrame {
  return typeof x === 'object' && x !== null && (x as ChunkFrame).k === MARKER;
}

export interface ChunkerOptions {
  /** how long a partial chunk group may linger before it is discarded (ms). */
  timeoutMs?: number;
  /** maximum number of incomplete groups to hold (anti-memory-blowup). */
  maxGroups?: number;
}

/**
 * Reassembles chunk frames back into the original serialized JSON.
 * Handles out-of-order arrival per group; discards stale groups.
 */
export class ChunkAssembler {
  private groups = new Map<
    string,
    { parts: Map<number, string>; total: number; seen: Set<number>; startedAt: number }
  >();
  private readonly timeoutMs: number;
  private readonly maxGroups: number;

  constructor(opts: ChunkerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxGroups = opts.maxGroups ?? 64;
  }

  /** Feed one decoded frame. Returns the reassembled JSON string when complete. */
  push(frame: unknown): string | undefined {
    if (!isChunkFrame(frame)) return undefined;
    let g = this.groups.get(frame.id);
    if (!g) {
      if (this.groups.size >= this.maxGroups) {
        // evict the oldest group
        let oldestId: string | undefined;
        let oldestTs = Infinity;
        for (const [id, group] of this.groups) {
          if (group.startedAt < oldestTs) {
            oldestTs = group.startedAt;
            oldestId = id;
          }
        }
        if (oldestId !== undefined) this.groups.delete(oldestId);
      }
      g = { parts: new Map(), total: frame.n, seen: new Set(), startedAt: Date.now() };
      this.groups.set(frame.id, g);
    }
    if (frame.i < 0 || frame.i >= g.total) return undefined; // malformed index
    g.parts.set(frame.i, frame.d);
    g.seen.add(frame.i);
    if (g.seen.size === g.total) {
      const json = Array.from({ length: g.total }, (_, i) => g.parts.get(i) ?? '').join('');
      this.groups.delete(frame.id);
      return json;
    }
    return undefined;
  }

  /** Drop groups older than timeoutMs (call from a timer if you want cleanup). */
  sweep(now = Date.now()): void {
    for (const [id, g] of this.groups) {
      if (now - g.startedAt > this.timeoutMs) this.groups.delete(id);
    }
  }
}
