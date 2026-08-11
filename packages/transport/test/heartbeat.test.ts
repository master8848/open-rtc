import { describe, it, expect, vi } from 'vitest';
import { Heartbeat, PresenceSweeper } from '../src/internal/heartbeat.js';

describe('Heartbeat', () => {
  it('calls onBeat on an interval', async () => {
    const onBeat = vi.fn();
    const hb = new Heartbeat({ intervalMs: 20, onBeat });
    hb.start();
    await new Promise((r) => setTimeout(r, 65));
    hb.stop();
    expect(onBeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(hb.running).toBe(false);
  });

  it('start is idempotent', () => {
    const hb = new Heartbeat({ intervalMs: 1000, onBeat: () => {} });
    hb.start();
    hb.start();
    hb.stop();
  });

  it('swallows errors from onBeat', async () => {
    const onError = vi.fn();
    const hb = new Heartbeat({
      intervalMs: 20,
      onBeat: () => {
        throw new Error('boom');
      },
      onError,
    });
    hb.start();
    await new Promise((r) => setTimeout(r, 50));
    hb.stop();
    expect(onError).toHaveBeenCalled();
  });
});

describe('PresenceSweeper', () => {
  it('marks stale peers and calls onStale once', () => {
    const onStale = vi.fn();
    const sw = new PresenceSweeper({ timeoutMs: 100, onStale });
    sw.touch('a', 0);
    expect(sw.sweep(50)).toEqual([]);
    expect(sw.sweep(150)).toEqual(['a']);
    expect(sw.sweep(200)).toEqual([]); // already removed
    expect(onStale).toHaveBeenCalledWith('a');
  });

  it('remove clears a peer without onStale', () => {
    const onStale = vi.fn();
    const sw = new PresenceSweeper({ timeoutMs: 10, onStale });
    sw.touch('a', 0);
    sw.remove('a');
    expect(sw.sweep(100)).toEqual([]);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('start returns a stop function', async () => {
    const onStale = vi.fn();
    const sw = new PresenceSweeper({ timeoutMs: 20, onStale });
    sw.touch('a', 0);
    const stop = sw.start(10);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(onStale).toHaveBeenCalled();
  });
});
