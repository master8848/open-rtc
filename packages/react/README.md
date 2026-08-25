# @mbsks/react

React bindings for vidcall: thin `useSyncExternalStore` hooks over
`@mbsks/core`'s `Room` snapshot layer (`room.subscribe()` /
`room.getSnapshot()`). StrictMode-safe.

```sh
npm install @mbsks/react @mbsks/core react
```

```tsx
import { useJoin, useParticipants, useRoomState } from '@mbsks/react';
import { Room } from '@mbsks/core';

function Call({ room }: { room: Room }) {
  useJoin(room); // auto-join on mount; aborts + leaves on unmount
  const snapshot = useRoomState(room); // stable, immutable state object
  const participants = useParticipants(room);

  return (
    <main>
      <p>
        status: {snapshot.status} · peers: {participants.length}
      </p>
      {participants.map((p) => (
        <p key={p.id}>
          {p.displayName ?? p.id} — {p.presence} ({p.connectionState})
        </p>
      ))}
    </main>
  );
}
```

## API

| Hook                       | What it returns                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `useRoomState(room)`       | The room's immutable `RoomSnapshot`; re-renders only when the engine changed it.                                                 |
| `useParticipants(room)`    | Stable roster array from the snapshot.                                                                                           |
| `useParticipant(room, id)` | One stable participant record (or `undefined`).                                                                                  |
| `useJoin(room, options?)`  | Auto-join on mount with `AbortSignal` cleanup; StrictMode double-mount safe. See `UseJoinOptions` (`onError`, `leaveOnUnmount`). |

Snapshot caching and equality checks live in **core** (`Room.getSnapshot()`),
not in these hooks — selectors only forward members of the snapshot, so
references stay stable across renders. Create one `Room` per `(roomId,
selfId)`: instances are disposable and cannot rejoin after `leave()`.

## Testing note (dependency publish dates)

Dependencies are exact-pinned per `CONTRIBUTING.md`; the pins below relied on
these registry timestamps (`https://registry.npmjs.org/<pkg>` → `time`),
verified on **2026-08-25** (14-day age rule cutoff: 2026-08-11):

| Package                  | Version | Published  |
| ------------------------ | ------- | ---------- |
| `react` / `react-dom`    | 19.2.8  | 2026-07-21 |
| `@types/react`           | 19.2.17 | 2026-06-05 |
| `@types/react-dom`       | 19.2.3  | 2025-11-12 |
| `@testing-library/react` | 16.3.2  | 2026-01-19 |
| `@testing-library/dom`   | 10.4.1  | 2025-07-27 |
| `jsdom`                  | 30.0.1  | 2026-07-29 |
| `vitest`                 | 4.1.10  | 2026-07-06 |

`react` itself is a **peer** dependency (`>=18`); everything above is a
devDependency used by this package's vitest suite only.
