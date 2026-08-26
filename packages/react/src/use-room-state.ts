/**
 * `useSyncExternalStore` bindings over `Room`'s snapshot layer.
 *
 * Rules of the adapter (docs/reviews/perspective-tanstack.md §1):
 *  - Snapshot caching and equality live in **core** (`Room.getSnapshot()`),
 *    never in the hook — the hook only forwards references.
 *  - Selectors must not break referential stability: they return members of
 *    the stable snapshot (arrays/records), never freshly-built objects.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Room } from '@mbsks/openrtc-core';
import type { RoomParticipantSnapshot, RoomSnapshot } from '@mbsks/openrtc-core';

/**
 * The room's current immutable snapshot. Re-renders only when the engine
 * produced a new snapshot reference (i.e. tracked state actually changed).
 * When a `selector` is provided, re-renders only when the selected slice
 * changes (TanStack Store style).
 */
export function useRoomState(room: Room): RoomSnapshot;
export function useRoomState<T>(room: Room, selector: (snapshot: RoomSnapshot) => T): T;
export function useRoomState<T>(room: Room, selector?: (snapshot: RoomSnapshot) => T): RoomSnapshot | T {
  const subscribe = useCallback(
    (onStoreChange: () => void) => (room as unknown as { subscribe: (cb: () => void) => () => void }).subscribe?.(onStoreChange) ?? room.store.subscribe(onStoreChange),
    [room],
  );
  const getSnapshot = useCallback(() => room.getSnapshot(), [room]);
  if (!selector) {
    // The snapshot is synchronously available on the server too, so the same
    // getter serves as the server snapshot.
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as RoomSnapshot;
  }
  // Selector path: only re-render when selected value changes (Object.is).
  const getSelectedSnapshot = useCallback(() => selector(room.getSnapshot()), [room, selector]);
  type Listener = () => void;
  const subscribeSelector = useCallback(
    (onStoreChange: Listener) => {
      let last = selector(room.getSnapshot());
      const baseSubscribe = (room as unknown as { subscribe: (cb: () => void) => () => void }).subscribe?.bind(room) ?? room.store.subscribe.bind(room.store);
      return baseSubscribe(() => {
        const next = selector(room.getSnapshot());
        if (!Object.is(last, next)) {
          last = next;
          onStoreChange();
        }
      });
    },
    [room, selector],
  );
  return useSyncExternalStore(subscribeSelector, getSelectedSnapshot, getSelectedSnapshot) as T;
}

/**
 * Stable roster array from the room snapshot. Same array reference until a
 * participant (or their presence/connection/publications) changes.
 */
export function useParticipants(room: Room): readonly RoomParticipantSnapshot[] {
  return useRoomState(room).participants;
}

/**
 * One participant record by id (`undefined` until they join). Returns the
 * snapshot's own record, so it stays referentially stable while unchanged.
 */
export function useParticipant(room: Room, id: string): RoomParticipantSnapshot | undefined {
  return useRoomState(room).participants.find((participant) => participant.id === id);
}
