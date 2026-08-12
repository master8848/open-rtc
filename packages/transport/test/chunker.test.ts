import { describe, it, expect } from 'vitest';
import { splitUtf8, encodeChunks, isChunkFrame, ChunkAssembler } from '../src/internal/chunker.js';

describe('splitUtf8', () => {
  it('splits ASCII at byte boundaries', () => {
    const parts = splitUtf8('a'.repeat(15000), 7000);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => new TextEncoder().encode(p).length <= 7000 + 0)).toBe(true);
    expect(parts.join('')).toBe('a'.repeat(15000));
  });

  it('never tears a multi-byte code point', () => {
    const input = '🏠'.repeat(5000) + 'héllo wörld ' + '中文字符'.repeat(2000);
    const parts = splitUtf8(input, 7000);
    expect(parts.join('')).toBe(input);
    // every part must decode cleanly (no lone surrogate / torn sequence)
    for (const p of parts) {
      expect(() => new TextDecoder().decode(new TextEncoder().encode(p))).not.toThrow();
    }
  });

  it('handles empty and tiny inputs', () => {
    expect(splitUtf8('', 7000)).toEqual(['']);
    expect(splitUtf8('x', 7000)).toEqual(['x']);
    expect(() => splitUtf8('x', 0)).toThrow();
  });
});

describe('encodeChunks / ChunkAssembler', () => {
  it('round-trips a payload larger than the cap', () => {
    const json = JSON.stringify({
      v: 1,
      type: 'offer',
      roomId: 'r',
      senderId: 's',
      sessionId: 'x',
      ts: 1,
      seq: 0,
      payload: { sdp: 'x'.repeat(20000) },
    });
    expect(new TextEncoder().encode(json).length).toBeGreaterThan(7000);
    const frames = encodeChunks(json, 7000);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]!.i).toBe(0);
    expect(frames.every((f) => isChunkFrame(f))).toBe(true);
    expect(new Set(frames.map((f) => f.id)).size).toBe(1);
    expect(frames[frames.length - 1]!.n).toBe(frames.length);

    const asm = new ChunkAssembler();
    // feed out of order: all parts except the first, then the first completes
    for (const f of [...frames].slice(1).reverse()) {
      asm.push(f);
    }
    expect(asm.push(frames[0]!)).toBe(json);
  });

  it('returns undefined until complete', () => {
    const json = JSON.stringify({ a: 'b'.repeat(10000) });
    const frames = encodeChunks(json, 7000);
    const asm = new ChunkAssembler();
    expect(asm.push(frames[0])).toBeUndefined();
    expect(asm.push(frames[1])).toBe(json);
  });

  it('ignores non-chunk frames', () => {
    const asm = new ChunkAssembler();
    expect(asm.push({ hello: 'world' })).toBeUndefined();
    expect(asm.push(null)).toBeUndefined();
  });

  it('evicts stale groups', () => {
    const asm = new ChunkAssembler({ timeoutMs: 10 });
    const json = JSON.stringify({ a: 'b'.repeat(10000) });
    const frames = encodeChunks(json, 7000);
    asm.push(frames[0]);
    asm.sweep(Date.now() + 100);
    // group gone → feeding part 1 starts a fresh incomplete group
    expect(asm.push(frames[1])).toBeUndefined();
  });
});
