# @vidcall/backend-appwrite

Signaling adapter for **Appwrite Realtime** — one of the six interchangeable
backends for the vidcall engine. See
[`@vidcall/transport`](../transport/README.md) for the contract every adapter
implements and the shared test suite each one must pass.

## How it works

Appwrite realtime is **server → client only**: no client-to-client broadcast
and no native presence. The adapter models signaling as **document events**:

- **`signals` collection** — one document per envelope frame
  (`{ roomId, senderId, frame }`); `emit()` → `createDocument()`, and the
  Realtime event callback fires for every new document (filtered by room,
  deduped by `$id` — Appwrite echoes your own writes back).
- **`presence` collection** — one heartbeat document per peer
  (`{ roomId, userId, state, metadata, lastSeen }`), upserted on each beat,
  deleted on leave; a late joiner snapshots the collection with
  `listDocuments()`; stale peers are swept after `presenceTimeoutMs`.

Because realtime messages are **metered**, ICE candidates are coalesced by
default (`coalesceIceMs: 100`). Ordering is per-document-commit per writer;
cross-writer interleaving goes through the shared seq reorder buffer.

## Install

```sh
npm i @vidcall/backend-appwrite          # once published
# today (workspace): npm i file:../vidcall/packages/backend-appwrite
```

## Usage

```ts
import { Client } from 'appwrite';
import { AppwriteBackend } from '@vidcall/backend-appwrite';
import { Room } from '@vidcall/core';

const client = new Client().setEndpoint('https://cloud.appwrite.io/v1').setProject('<project-id>'); // browser client — permissions gate the collections

const backend = new AppwriteBackend({
  client,
  databaseId: '<database-id>',
  signalsCollectionId: 'vidcall_signals',
  presenceCollectionId: 'vidcall_presence',
});

const room = new Room({
  roomId: 'demo',
  selfId: 'alice',
  transport: backend,
});
await room.join();
await room.publish(cameraTrack);
```

## Setup

Create a database and two collections in Appwrite:

| Collection         | Attributes                                                                                  | Purpose                    |
| ------------------ | ------------------------------------------------------------------------------------------- | -------------------------- |
| `vidcall_signals`  | `roomId: string`, `senderId: string`, `frame: string`                                       | one doc per envelope frame |
| `vidcall_presence` | `roomId: string`, `userId: string`, `state: string`, `metadata: string`, `lastSeen: number` | one heartbeat doc per peer |

Then subscribe the adapter to the database-level Realtime channel (it does
this automatically for the two collection ids you pass in).

## Caveats

- **No client-to-client broadcast** — the adapter's document-event model is
  the closest Appwrite maps to signaling; use the **client SDK** in the
  browser (permissions on the two collections must let clients create/read
  documents), and the **server SDK** (`client.setKey(...)`) in Node/backend
  contexts.
- **Billing** — realtime messages are metered; ICE coalescing is on by
  default for that reason.
- **Ordering** — `seq-required`; SDP-bearing kinds are reassembled in order
  by `BaseSignalingTransport`.

## Tests

Runs against the shared adapter suite (see
[`@vidcall/transport/shared-tests`](../transport/README.md#shared-adapter-tests))
plus adapter-specific unit tests:

```sh
cd packages/backend-appwrite && npm run test
```
