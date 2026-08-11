/**
 * @vidcall/transport — signaling transport contract + helpers.
 *
 * Public surface:
 *  - `SignalingTransport`: structural twin of `@vidcall/core`'s interface
 *    (join/leave/emit/onMessage/onPresence/setPresence/dispose) — backend
 *    adapters implement this; TypeScript structural typing makes them
 *    assignable to core's `SignalingTransport` directly.
 *  - `SignalingBackend` + `SignalingMessage`: legacy room-arg interface from
 *    docs/research/backend-adapters.md §10 (kept for compatibility).
 *  - `BaseSignalingTransport`: shared adapter plumbing (chunking, reorder,
 *    heartbeat, ICE coalescing) — extend this in backend adapters.
 *  - `InMemoryBackend`: in-process test double.
 *  - helpers under `@vidcall/transport/internal`: chunker, reorder buffer,
 *    heartbeat + presence sweeper, ICE coalescer.
 *  - `@vidcall/transport/shared-tests`: the shared adapter test suite every
 *    backend adapter must pass.
 */
export * from './types.js';
export * from './wire.js';
export * from './base.js';
export * from './InMemoryBackend.js';
