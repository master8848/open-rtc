/**
 * @mbsks/react — React bindings over the @mbsks/core snapshot layer.
 *
 * Thin `useSyncExternalStore` adapters: all caching and equality checks live
 * in core (`Room.getSnapshot()` / `Room.subscribe()`); these hooks never
 * build state themselves, so referential stability is guaranteed by the
 * engine, not the adapter.
 */
export { useRoomState, useParticipants, useParticipant } from './use-room-state.ts';
export { useJoin, type UseJoinOptions } from './use-join.ts';
