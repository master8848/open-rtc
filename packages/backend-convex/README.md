# @mbsks/backend-convex

Convex signaling adapter: rooms are **Convex tables**, writes are
**mutations** (serialized, transactional, strongly ordered), reads are
**live queries** (subscriptions). No extra infrastructure — your Convex
deployment IS the signaling bus.

## Usage

```ts
import { ConvexBackend } from '@mbsks/backend-convex';
import { ConvexClient } from 'convex/browser';

const backend = new ConvexBackend({
  convex: new ConvexClient('https://<deployment>.convex.cloud'), // or pass url directly
});
await backend.join('room-42', { id: 'me' });
backend.onMessage((envelope) => { /* engine */ });
await backend.emit({ v: 1, type: 'chat', roomId: 'room-42', senderId: 'me', sessionId: 's', ts: Date.now(), seq: 0, payload: { text: 'hi' } });
await backend.setPresence('online', { camOn: true });
await backend.leave();
await backend.dispose(); // closes the client only if the adapter created it
```

## Deploy the reference functions

The package ships the server side under `convex/` (schema + `signals.ts` +
`presence.ts`). Copy them into your Convex project and deploy:

```sh
cp packages/backend-convex/convex/*.ts convex/
npx convex deploy
```

The adapter calls mutations/queries by **string name**
(`signals:send`, `signals:list`, `presence:upsert`, `presence:remove`,
`presence:list`), so any compatible deployment works.

## How it works

| vidcall concept | Convex |
|---|---|
| room | `signals` table, indexed by `roomId` |
| `emit(envelope)` | `signals:send` mutation (append row, frame JSON) |
| `onMessage` | `signals:list` subscription — Convex pushes the **full result set**; the adapter **diffs by `_id`** and delivers only new frames |
| presence | `presence:upsert` heartbeat mutation + `presence:list` subscription + stale sweep (Convex has no native presence) |
| leave | unsubscribes + `presence:remove` |

## Ordering & limits

- **`ordering: 'guaranteed'`** — mutations are serialized and strongly
  consistent, so SDP offer/answer arrive in order. (The per-sender seq
  reorder buffer is still on as a safety net.)
- **16 MiB function-arg cap** — far above any SDP/ICE payload; chunking is
  effectively never needed (`maxPayloadBytes = 16 MiB`).
- **Presence is heartbeat-based** (rows go stale after `presenceTimeoutMs`,
  default 15 s); unlike Firebase/Supabase there is no server-side disconnect
  hook, so presence lags by up to one timeout on abrupt drops.

## Limits & caveats

- Query results are full-room snapshots; rooms with very high message volume
  grow the result set (Convex paginates queries — not needed for signaling
  scale). The adapter bounds its seen-id cache (drops oldest after 4096).
- `presence:list` rows are delivered to every subscriber including the
  writer — the adapter's diff suppresses self-duplicates.

## Package

- Pin: `convex@1.42.3` (published 2026-06-13 — 59 d old at implementation
  time). Uses the `onUpdate`/`mutation` browser-client API (renamed from
  `subscribe` in this version).
- Dev pins: `@types/node@22.19.1`, `typescript@5.9.3`, `vitest@4.1.10`.
