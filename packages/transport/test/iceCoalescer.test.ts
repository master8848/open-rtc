import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@vidcall/protocol';
import { IceCoalescer } from '../src/internal/iceCoalescer.js';

function ice(i: number): Envelope {
  return createEnvelope('ice', { roomId: 'r', senderId: 'a', sessionId: 's', seq: i, payload: { candidate: `candidate:${i}`, sdpMid: null, sdpMLineIndex: null } });
}

describe('IceCoalescer', () => {
  it('batches items within the window into one flush', async () => {
    const onFlush = vi.fn();
    const c = new IceCoalescer({ windowMs: 30, onFlush });
    c.push(ice(1));
    c.push(ice(2));
    c.push(ice(3));
    expect(c.size).toBe(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]![0].length).toBe(3);
    c.dispose();
  });

  it('flushes immediately on flush call', async () => {
    const onFlush = vi.fn();
    const c = new IceCoalescer({ windowMs: 10_000, onFlush });
    c.push(ice(1));
    await c.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(c.size).toBe(0);
    c.dispose();
  });

  it('maxItems forces a flush', async () => {
    const onFlush = vi.fn();
    const c = new IceCoalescer({ windowMs: 10_000, maxItems: 2, onFlush });
    c.push(ice(1));
    c.push(ice(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(onFlush).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('reports errors via onError', async () => {
    const onError = vi.fn();
    const c = new IceCoalescer({
      windowMs: 10,
      onFlush: () => {
        throw new Error('nope');
      },
      onError,
    });
    c.push(ice(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(onError).toHaveBeenCalled();
    c.dispose();
  });
});
