import { beforeEach, describe, expect, it } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { Room, InMemoryTransport } from '@mbsks/openrtc-core';
import { resetFakeRTC } from '@mbsks/openrtc-test-utils';
import { sleep } from '../../test-utils/src/fixtures.ts';
import { useParticipants, useRoomState } from '../src/index.ts';

beforeEach(() => resetFakeRTC());

function makeRoomPair(): { a: Room; b: Room } {
  const a = new Room({ roomId: 'room-1', selfId: 'a', transport: new InMemoryTransport() });
  const b = new Room({ roomId: 'room-1', selfId: 'b', transport: new InMemoryTransport() });
  return { a, b };
}

async function joinBoth(a: Room, b: Room): Promise<void> {
  await act(async () => {
    await a.join();
    await b.join();
  });
}

describe('useRoomState', () => {
  it('renders the initial snapshot and updates when the roster changes', async () => {
    const { a, b } = makeRoomPair();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useRoomState(b);
    });

    expect(result.current.status).toBe('new');
    expect(result.current.participants).toEqual([]);
    const initial = result.current;

    await joinBoth(a, b);
    // Allow the microtasked envelope delivery to land while mounted.
    await act(async () => {
      await sleep(5);
    });

    expect(result.current.status).toBe('joined');
    expect(result.current.participants.map((p) => p.id)).toEqual(['a']);
    expect(renders).toBeGreaterThanOrEqual(2);
    // The snapshot object itself was replaced exactly when state changed.
    expect(result.current).not.toBe(initial);

    void a.leave();
    void b.leave();
  });

  it('does not re-render on unrelated updates (reactions)', async () => {
    const { a, b } = makeRoomPair();
    let renders = 0;
    renderHook(() => {
      renders++;
      return useRoomState(b);
    });
    await joinBoth(a, b);
    const rendersAfterJoin = renders;

    await act(async () => {
      await a.sendReaction('🎉');
      await a.sendChat('unrelated');
      await sleep(5);
    });

    expect(renders).toBe(rendersAfterJoin);
    void a.leave();
    void b.leave();
  });

  it('keeps the participants array referentially stable between unrelated updates', async () => {
    const { a, b } = makeRoomPair();
    const { result } = renderHook(() => useParticipants(b));
    await joinBoth(a, b);
    await act(async () => {
      await sleep(5);
    });
    const stable = result.current;
    expect(stable.length).toBe(1);

    await act(async () => {
      await a.sendReaction('👋');
      await sleep(5);
    });
    expect(result.current).toBe(stable);
    void a.leave();
    void b.leave();
  });

  it('unsubscribes from the room on unmount', async () => {
    const { a, b } = makeRoomPair();
    let activeSubscriptions = 0;
    const originalSubscribe = b.subscribe.bind(b);
    b.subscribe = ((listener: () => void) => {
      const unsubscribe = originalSubscribe(listener);
      activeSubscriptions++;
      return () => {
        activeSubscriptions--;
        unsubscribe();
      };
    }) as typeof b.subscribe;

    const { unmount } = renderHook(() => useRoomState(b));
    expect(activeSubscriptions).toBe(1);
    unmount();
    expect(activeSubscriptions).toBe(0);

    void a.leave();
    void b.leave();
  });

  it('is StrictMode-safe: double render keeps one subscription and stable snapshots', async () => {
    const { a, b } = makeRoomPair();
    let activeSubscriptions = 0;
    const originalSubscribe = b.subscribe.bind(b);
    b.subscribe = ((listener: () => void) => {
      const unsubscribe = originalSubscribe(listener);
      activeSubscriptions++;
      return () => {
        activeSubscriptions--;
        unsubscribe();
      };
    }) as typeof b.subscribe;

    const { result } = renderHook(() => useRoomState(b), { wrapper: StrictMode });
    await joinBoth(a, b);
    await act(async () => {
      await sleep(5);
    });

    expect(activeSubscriptions).toBe(1);
    expect(result.current.status).toBe('joined');
    void a.leave();
    void b.leave();
  });
});
