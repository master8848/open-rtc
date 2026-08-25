---
"@mbsks/openrtc-core": minor
"@mbsks/openrtc-react": minor
"@mbsks/openrtc-server": minor
---

Snapshot layer, React bindings, and slimmer server packaging.

- **@mbsks/openrtc-core**: observable snapshot layer — `room.subscribe(listener)` /
  `room.getSnapshot()` for `useSyncExternalStore`-style consumers, plus an
  abortable serialized `join()`.
- **@mbsks/openrtc-react**: new package with `useRoomState`, `useParticipants`,
  `useParticipant`, and `useJoin` hooks over the core snapshot store
  (StrictMode-safe).
- **@mbsks/openrtc-server**: zero-driver default install — SQL stores and framework
  adapters moved behind subpath exports, database drivers are optional peer
  dependencies with actionable install errors.
