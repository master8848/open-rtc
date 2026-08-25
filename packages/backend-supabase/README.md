# @mbsks/openrtc-backend-supabase

Supabase Realtime signaling adapter — the **default** vidcall backend. Uses
Realtime's native **broadcast** (SDP/ICE/reactions/chat) and **presence**
("who's in the call") over one WebSocket.

## Usage

```ts
import { createClient } from '@supabase/supabase-js';
import { SupabaseBackend } from '@mbsks/openrtc-backend-supabase';

const supabase = createClient('https://<ref>.supabase.co', '<anon-key>');
const backend = new SupabaseBackend({ client: supabase });

await backend.join('room-42', { id: 'me', displayName: 'Alice' });
backend.onMessage((envelope) => {
  if (envelope.type === 'offer') /* engine handles SDP */;
});
backend.onPresence((presence) => {
  console.log(presence.participantId, presence.state, presence.metadata);
});
await backend.emit({
  v: 1, type: 'chat', roomId: 'room-42', senderId: 'me',
  sessionId: 'my-session', ts: Date.now(), seq: 0,
  payload: { text: 'hi' },
});
await backend.setPresence('online', { camOn: true, muted: false });
// ... later
await backend.leave();
await backend.dispose();
```

The adapter implements `SignalingTransport` (packages/core contract; structural
twin in `@mbsks/openrtc-transport`), so it plugs straight into the vidcall engine.

## How it maps

| vidcall concept | Supabase Realtime |
|---|---|
| room channel | `client.channel(roomId)` |
| `emit(envelope)` | `channel.send({ type:'broadcast', event: envelope.type, payload: envelope })` |
| `onMessage` | `channel.on('broadcast', { event: '*' })` |
| presence | `channel.track({ id, state, metadata })` + `sync/join/leave` events |
| leave | `channel.unsubscribe()` + `untrack()` |

## Limits & caveats

- **Free tier**: 256 KB broadcast payload (SDP fits with 50× headroom),
  **100 msg/s** — trickle bursts are coalesced into a 100 ms window
  (`coalesceIceMs`) so a 30-candidate burst is a few sends, not 30.
- **Ordering**: broadcast has no strict cross-publisher ordering →
  `ordering: 'seq-required'`; the adapter reorders `offer`/`answer`/`sfu` by
  per-sender `seq` on arrival (disable with `reorder: false` if the engine
  reorders — it is idempotent either way).
- **Presence** is backend-native: no heartbeat needed; disconnects (clean or
  crash) are reflected automatically. Watch the 5 presence calls per 30 s
  client limit — the engine should not spam `setPresence`.
- **Auth**: private channels require a signed JWT; configure RLS so only room
  members can subscribe. The adapter passes the client through untouched.
- Payloads above 256 KB are chunked transparently (the generic chunker in
  `@mbsks/openrtc-transport`); you will never hit this with SDP/ICE.

## Package

- Pin: `@supabase/supabase-js@2.110.9` (published 2026-07-27 — 15 d old at
  implementation time; re-verified `npm view @supabase/supabase-js time`).
- Runtime deps: `@supabase/supabase-js`, `@mbsks/openrtc-transport`.
