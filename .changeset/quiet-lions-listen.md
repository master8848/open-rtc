---
"@vidcall/core": minor
"@vidcall/react": minor
"@vidcall/server": minor
---

Snapshot layer, React bindings, and slimmer server packaging.

- **@vidcall/core**: observable snapshot layer — `room.subscribe(listener)` /
  `room.getSnapshot()` for `useSyncExternalStore`-style consumers, plus an
  abortable serialized `join()`.
- **@vidcall/react**: new package with `useRoomState`, `useParticipants`,
  `useParticipant`, and `useJoin` hooks over the core snapshot store
  (StrictMode-safe).
- **@vidcall/server**: zero-driver default install — SQL stores and framework
  adapters moved behind subpath exports, database drivers are optional peer
  dependencies with actionable install errors.
