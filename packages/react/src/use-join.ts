/**
 * `useJoin` — the StrictMode-safe join lifecycle (docs/reviews/
 * perspective-tanstack.md §1, roadmap #8).
 *
 * The hook starts `room.join()` in an effect with its own `AbortSignal`, and
 * cleanup aborts that signal. On a `<StrictMode>` mount → unmount → mount
 * cycle the first join is rolled back by the engine (subscriptions removed,
 * transport session released — see `Room.JoinOptions`) while the deferred
 * leave is cancelled, so exactly one clean join survives. On a real unmount
 * the room is left (and closed) shortly after.
 *
 * Rooms are disposable: after `leave()`/`close()` an instance cannot rejoin
 * (`join()` throws 'Room is closed'). Key rooms by `(roomId, selfId)` and
 * treat instances as single-use; this hook only ever auto-joins once per
 * room instance.
 */
import { useEffect, useRef } from 'react';
import type { Room } from '@mbsks/openrtc-core';

export interface UseJoinOptions {
  /**
   * Called when the auto-join fails for a reason other than teardown
   * (StrictMode-induced aborts are expected and not reported). When omitted,
   * failures are logged via `console.error`.
   */
  onError?: (error: Error) => void;
  /**
   * Leave (and close) the room when the component unmounts for good. The
   * leave is deferred one macrotask so a `<StrictMode>` remount can cancel
   * it. Default: `true`. Set to `false` if you own the room's full lifecycle.
   */
  leaveOnUnmount?: boolean;
}

/**
 * Auto-join `room` on mount with abort/cleanup on unmount. Returns nothing;
 * read join state from `useRoomState(room).status`.
 */
export function useJoin(room: Room, options: UseJoinOptions = {}): void {
  const optionsRef = useRef<UseJoinOptions>(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // A remount cancels the pending leave scheduled by the previous cleanup.
    clearTimeout(leaveTimer.current);
    const controller = new AbortController();
    room.join({ signal: controller.signal }).catch((err: unknown) => {
      if (controller.signal.aborted) return; // torn-down mount: expected
      const error = err instanceof Error ? err : new Error(String(err));
      const onError = optionsRef.current.onError;
      if (onError) onError(error);
      else console.error('[vidcall] room.join failed:', error);
    });
    return () => {
      controller.abort();
      if (optionsRef.current.leaveOnUnmount ?? true) {
        // Deferred so <StrictMode>'s immediate remount cancels it.
        leaveTimer.current = setTimeout(() => {
          void room.leave();
        }, 0);
      }
    };
  }, [room]);
}
