import { describe, it, expect } from 'vitest';
import { createEnvelope, type Envelope } from '@vidcall/protocol';
import { ReorderBuffer } from '../src/internal/reorder.js';

function msg(seq: number, type: 'offer' | 'ice' | 'chat' = 'offer', sender = 'a'): Envelope {
  return createEnvelope(type, {
    roomId: 'r',
    senderId: sender,
    sessionId: 's',
    seq,
  });
}

describe('ReorderBuffer', () => {
  it('passes unordered kinds (ice) straight through', () => {
    const rb = new ReorderBuffer();
    const out = rb.push(msg(5, 'ice'));
    expect(out.length).toBe(1);
    expect(out[0]!.seq).toBe(5);
    expect(rb.bufferedCount).toBe(0);
  });

  it('releases ordered messages only in seq order', () => {
    const rb = new ReorderBuffer();
    const out: number[] = [];
    for (const m of [msg(0), msg(2), msg(3), msg(1)]) {
      out.push(...rb.push(m).map((x) => x.seq));
    }
    expect(out).toEqual([0, 1, 2, 3]);
    expect(rb.bufferedCount).toBe(0);
  });

  it('drops duplicates and already-seen seqs', () => {
    const rb = new ReorderBuffer();
    expect(rb.push(msg(0)).map((m) => m.seq)).toEqual([0]);
    expect(rb.push(msg(0)).length).toBe(0);
    expect(rb.push(msg(1)).map((m) => m.seq)).toEqual([1]);
  });

  it('buffers per sender independently', () => {
    const rb = new ReorderBuffer();
    const out: string[] = [];
    out.push(...rb.push(msg(2, 'offer', 'a')).map((m) => `${m.senderId}:${m.seq}`));
    out.push(...rb.push(msg(3, 'offer', 'a')).map((m) => `${m.senderId}:${m.seq}`));
    out.push(...rb.push(msg(0, 'offer', 'a')).map((m) => `${m.senderId}:${m.seq}`));
    out.push(...rb.push(msg(1, 'offer', 'a')).map((m) => `${m.senderId}:${m.seq}`));
    out.push(...rb.push(msg(1, 'offer', 'b')).map((m) => `${m.senderId}:${m.seq}`));
    out.push(...rb.push(msg(0, 'offer', 'b')).map((m) => `${m.senderId}:${m.seq}`));
    expect(out).toEqual(['a:0', 'a:1', 'a:2', 'a:3', 'b:0', 'b:1']);
  });

  it('flushes a run when the gap exceeds maxGap', () => {
    const rb = new ReorderBuffer({ maxGap: 3 });
    expect(rb.push(msg(0)).map((m) => m.seq)).toEqual([0]);
    const out = rb.push(msg(10));
    expect(out.map((m) => m.seq)).toEqual([10]);
  });

  it('custom ordered-kinds predicate', () => {
    const rb = new ReorderBuffer({ orderedKinds: new Set(['chat']) });
    expect(rb.push(msg(0, 'chat')).map((m) => m.seq)).toEqual([0]);
    expect(rb.push(msg(1, 'chat')).map((m) => m.seq)).toEqual([1]);
    expect(rb.push(msg(9, 'offer')).map((m) => m.seq)).toEqual([9]);
  });

  it('reset clears state; sweep drops idle senders', () => {
    const rb = new ReorderBuffer({ timeoutMs: 10 });
    rb.push(msg(2));
    expect(rb.bufferedCount).toBe(1);
    expect(rb.senderCount).toBe(1);
    rb.sweep(Date.now() + 100);
    expect(rb.senderCount).toBe(0);
    rb.push(msg(3));
    rb.reset();
    expect(rb.bufferedCount).toBe(0);
    expect(rb.senderCount).toBe(0);
  });
});
