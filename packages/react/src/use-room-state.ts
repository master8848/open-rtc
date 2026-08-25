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
import type { Room } from '@vidcall/core';
import type { RoomParticipantSnapshot, RoomSnapshot } from '@vidcall/core';

/**
 * The room's current immutable snapshot. Re-renders only when the engine
 * produced a new snapshot reference (i.e. tracked state actually changed).
 */
export function useRoomState(room: Room): RoomSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => room.subscribe(onStoreChange),
    [room],
  );
  const getSnapshot = useCallback(() => room.getSnapshot(), [room]);
  // The snapshot is synchronously available on the server too, so the same
  // getter serves as the server snapshot.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
