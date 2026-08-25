import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useEffect } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { InMemoryTransport, Room } from '@mbsks/core';
import { resetFakeRTC } from '@mbsks/test-utils';
import { sleep } from '../../test-utils/src/fixtures.ts';
import { useJoin } from '../src/index.ts';

beforeEach(() => resetFakeRTC());

/** Transport whose `join` can be held open to simulate a slow backend. */
class GatedTransport extends InMemoryTransport {
  gate: Promise<void> = Promise.resolve();
  releaseGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  override async join(
    roomId: string,
    self: Parameters<InMemoryTransport['join']>[1],
  ): Promise<void> {
    await this.gate;
    return super.join(roomId, self);
  }
}

describe('useJoin', () => {
  it('auto-joins on mount and the snapshot reaches "joined"', async () => {
    const room = new Room({ roomId: 'r', selfId: 'me', transport: new InMemoryTransport() });
    const onError = vi.fn();
    renderHook(() => useJoin(room, { onError }));

    await waitFor(() => expect(room.getSnapshot().status).toBe('joined'));
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      await room.leave();
    });
  });

  it('StrictMode double-mount: first join is aborted and rolled back, second survives', async () => {
    const transport = new GatedTransport();
    const room = new Room({ roomId: 'r', selfId: 'me', transport });
    transport.hold(); // keep every join's first step pending for now

    const onError = vi.fn();
    // Probe the harness effect to prove StrictMode really ran
    // setup → cleanup → setup (dev-build double-mount semantics).
    let effectRuns = 0;
    renderHook(
      () => {
        useEffect(() => {
          effectRuns++;
        }, []);
        useJoin(room, { onError });
      },
      { wrapper: StrictMode },
    );

    expect(effectRuns).toBe(2); // <StrictMode> double-mounted the effects

    // The deferred leave was cancelled by the remount; mount #1's join was
    // aborted before/while it ran and rolled back, so mount #2 completes
    // cleanly on the same room instance with exactly one live session.
    transport.releaseGate?.();
    await waitFor(() => expect(room.getSnapshot().status).toBe('joined'));
    expect(onError).not.toHaveBeenCalled(); // the abort was silent
    expect(transport.roomId).toBe('r'); // exactly one live session remains

    await act(async () => {
      await room.leave();
    });
  });

  it('leaves (closes) the room after a real unmount', async () => {
    const room = new Room({ roomId: 'r', selfId: 'me', transport: new InMemoryTransport() });
    const { unmount } = renderHook(() => useJoin(room));
    await waitFor(() => expect(room.getSnapshot().status).toBe('joined'));

    unmount();
    await act(async () => {
      await sleep(5); // the deferred macrotasked leave
    });
    expect(room.isClosed).toBe(true);
  });

  it('tolerates an explicit leave before unmount (leave() is idempotent)', async () => {
    const room = new Room({ roomId: 'r', selfId: 'me', transport: new InMemoryTransport() });
    const { unmount } = renderHook(() => useJoin(room));
    await waitFor(() => expect(room.isJoined).toBe(true));

    await act(async () => {
      await room.leave();
    });
    expect(() => unmount()).not.toThrow();
    await act(async () => {
      await sleep(5);
    });
    expect(room.isClosed).toBe(true);
  });

  it('reports unexpected join failures through onError (aborts are silent)', async () => {
    const room = new Room({ roomId: 'r', selfId: 'me', transport: new GatedTransport() });
    // A closed room makes join() throw synchronously inside runJoin.
    await act(async () => {
      await room.leave();
    });
    const onError = vi.fn();
    renderHook(() => useJoin(room, { onError }));
    await act(async () => {
      await sleep(5);
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/closed/i);
  });
});
