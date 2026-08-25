# Getting started with vidcall

This guide takes you from zero to a real video call: a tiny signaling server,
a React client, and the first-run gotchas. (For the 30-second tour, see the
[root README](../README.md).)

## The mental model

Three moving parts, and you only write code for one of them:

```
your app  (~20 lines of vidcall code)
   │
   └── Room ──────────────── one per person joining: create it, join it,
         │                    throw it away when they leave
         │
         ├── transport adapter ──► signaling relay ──► everyone else's Room
         │    small JSON messages only: "I'm here", "here's my offer",
         │    "try this network address" (ICE)
         │
         └── direct peer-to-peer connections (WebRTC mesh)
              the actual camera/mic streams flow browser → browser
```

Signaling is just the introductions. vidcall sends join/offer/ICE messages
through whatever channel you picked; after that, video and audio go directly
between browsers — the relay never carries the media itself. The engine also
handles everything fiddly about WebRTC: negotiation races when two people
call each other at once ("glare"), out-of-order messages, renegotiation when
someone turns a camera on mid-call, and reconnects.

## Before you start

```sh
git clone <repo-url> vidcall && cd vidcall
bun install && bun run build
```

Nothing is published to npm yet, so apps consume the packages straight from
this repo (workspace / `file:` dependencies). You'll also need a Supabase
project for the snippets below (free tier is fine) — or skip Step 1 entirely
with the zero-server trick at the end of it.

## Step 1 — a signaling server in ~10 lines

`@mbsks/server` ships rooms, a REST API, and a WebSocket relay. The default
store keeps everything in memory — perfect for a first run:

```ts
import express from 'express';
import { InMemoryStore, attachWebSocketRelay, createServices } from '@mbsks/server';
import { createExpressRouter } from '@mbsks/server/express';

const services = createServices({ store: new InMemoryStore() });
const app = express();
app.use('/vidcall', createExpressRouter(services));
const server = app.listen(3000, () => console.log('vidcall on :3000'));
attachWebSocketRelay(server, services); // WS relay at /ws?roomId=...
```

That's a whole signaling backend: clients talk HTTP to `/vidcall/*` and
WebSockets to `ws://localhost:3000/ws?roomId=...`.

> This runs in "legacy open mode": anyone can join any room. Fine for local
> dev, not for production — the server supports HMAC room tokens; see
> [Authentication & tokens](../packages/server/README.md#authentication--tokens).

No server at all? The SQLite adapter uses BroadcastChannel, so two tabs of one
browser can call each other with zero infrastructure — that's exactly what
[`examples/vanilla`](../examples/vanilla) does:

```sh
node examples/vanilla/build.mjs && npx serve examples/vanilla
```

## Step 2 — a React client

The full pattern lives in [`examples/react/src/App.tsx`](../examples/react/src/App.tsx).
Here is the shape of it, piece by piece.

### Create the Room once

A `Room` is disposable: after `leave()` it cannot rejoin, so key instances by
`(roomId, selfId)` and make a new one when needed. Give each page load a
stable id so React StrictMode remounts don't look like a second person:

```tsx
import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Room } from '@mbsks/core';
import { SupabaseBackend } from '@mbsks/backend-supabase';

// One identity per page load — survives StrictMode remounts.
const selfId = `user-${Math.random().toString(36).slice(2, 8)}`;

function useMyRoom(): Room | null {
  const [room, setRoom] = useState<Room | null>(null);
  useEffect(() => {
    const next = new Room({
      roomId: 'first-call',
      selfId,
      displayName: 'Guest',
      transport: new SupabaseBackend({
        client: createClient(
          import.meta.env.VITE_SUPABASE_URL,
          import.meta.env.VITE_SUPABASE_ANON_KEY,
        ),
      }),
    });
    setRoom(next);
    return () => void next.leave();
  }, []);
  return room;
}
```

### Join safely with `useJoin`

Don't call `room.join()` inside your own effect — React StrictMode mounts,
unmounts, and remounts every component once in development, which starts two
joins and can leave a half-joined session behind. The `useJoin` hook owns the
lifecycle: join on mount, abort an in-flight join on unmount, leave only on a
real unmount. It comes from `@mbsks/react` alongside two snapshot hooks:

```tsx
import { useJoin, useParticipants, useRoomState } from '@mbsks/react';

function Call({ room }: { room: Room }) {
  useJoin(room); // StrictMode-safe auto-join
  const state = useRoomState(room); // status: 'new' | 'joining' | 'joined' | 'closed'
  const participants = useParticipants(room);

  return (
    <ul>
      {participants.map((p) => (
        <li key={p.id}>{p.displayName ?? p.id}</li>
      ))}
    </ul>
  );
}
```

### Show remote video

Remote tracks arrive automatically (mesh = everyone subscribes to everyone).
Attachment to `<video>` elements is imperative, so it goes in an effect with
plain event listeners — snapshot hooks handle state, events handle media:

```tsx
function RemoteVideos({ room }: { room: Room }) {
  const videosRef = useRef(new Map<string, HTMLVideoElement>());

  useEffect(() => {
    const onTrack = ({ participant, track }: { participant: { id: string }; track: MediaStreamTrack }) => {
      let video = videosRef.current.get(participant.id);
      if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        document.body.append(video);
        videosRef.current.set(participant.id, video);
      }
      const stream = (video.srcObject as MediaStream | null) ?? new MediaStream();
      stream.addTrack(track);
      video.srcObject = stream;
    };
    room.on('track', onTrack);
    return () => room.off('track', onTrack);
  }, [room]);

  return null;
}
```

### Publish your camera

Getting your camera out is plain browser API — vidcall adds no wrapper. Grab
a track, then hand it to the room:

```tsx
async function shareCamera(room: Room): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  // Show yourself too:
  document.querySelector<HTMLVideoElement>('#self')!.srcObject = stream;
  // Send camera + mic to everyone:
  await room.publish(stream.getVideoTracks()[0]!, { source: 'camera' });
  for (const audio of stream.getAudioTracks()) await room.publish(audio, { source: 'microphone' });
}
```

Run the server from Step 1 plus this client in two tabs: both join
`first-call`, cameras come on, and there is your call.

## No React? Vanilla notes

Everything above works without any framework — the hooks are a thin layer over
core primitives you can use directly:

- `new Room({ roomId, selfId, transport })`, then `await room.join()`.
- `room.on('track', ...)`, `room.on('participant-joined', ...)`, etc. — typed
  event emitters.
- `room.publish(track)` / `room.unpublish(publication)` / `room.leave()`.
- `room.subscribe(listener)` + `room.getSnapshot()` if you want React-style
  state updates elsewhere.

A complete single-file example — including mute toggles, quality monitoring,
and recording — is [`examples/vanilla/main.ts`](../examples/vanilla/main.ts).

## Common first-run gotchas

1. **The camera needs localhost or HTTPS.** Browsers only grant
   `getUserMedia` on secure origins: `http://localhost` counts, `http://192.168.x.x`
   does not. If the camera button silently fails, check how you're serving the page.
2. **Start the relay before joining.** Clients discover each other through
   signaling; if the server isn't up (or Supabase credentials are missing),
   joining stalls or errors. Watch `state.status` and `room.on('error', ...)`.
3. **StrictMode double-mounts are expected.** If you see duplicate joins or
   ghost participants in dev, you're probably calling `room.join()` by hand —
   switch to `useJoin`. And remember rooms are single-use: create a fresh
   `Room` instead of reusing a left one.
4. **Two different networks need STUN.** Two tabs on one machine connect with
   no servers at all. Across Wi-Fi ↔ cellular or office networks, pass
   `iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]` to the `Room`
   config so peers can find a path to each other.
5. **Nothing is on npm yet.** Install commands like `npm i @mbsks/core`
   won't resolve until the first release; consume from this repo meanwhile
   (see the root README's quick start).

## Where to go next

- **Adaptive quality** — pass `quality: { intervalMs }` to the `Room` config
  and listen for `quality:changed` / `quality:warning`: the engine samples
  stats and moves down/up a tier ladder. The pure policy engine lives in
  [`packages/quality`](../packages/quality/README.md).
- **Controls & extras** — mute, camera, screen share, raise-hand, reactions,
  chat: the `ControlsManager` class wires these onto a room (see
  [`docs/features/controls.md`](features/controls.md)).
- **Recording** — `room.recording` composites local + remote streams into a
  MediaRecorder session and can upload chunks to `@mbsks/server`, where
  disk or S3-compatible storage keeps them.
- **Bigger calls** — the mesh is comfortable around 2–4 participants. Beyond
  that you want an SFU: [`packages/sfu-gateway`](../packages/sfu-gateway/README.md)
  has the interface and a mediasoup reference adapter (scaffolded; wiring into
  `Room` is still TODO).
- **Your own backend/transport** — implement the `SignalingTransport`
  interface from [`@mbsks/transport`](../packages/transport/README.md),
  validate with the shared test suite (`runAdapterTestSuite`), and check wire
  format against [`protocol/fixtures`](../protocol/fixtures).
- **Mobile** — Kotlin, Swift, and Dart bindings speak the same protocol; see
  their READMEs under [`packages/`](../packages).
