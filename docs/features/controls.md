# Controls — mute, camera, screen share, reactions, devices

> Status: implementation doc for `packages/core/src/controls/ControlsManager.ts`.
> `room.controls` is wired by `@mbsks/openrtc-core`'s index; the manager takes the
> `Room` as a structurally-compatible `ControlsHost`.

`ControlsManager` is the "Zoom-clone" control surface for the **local**
participant: mic mute/unmute, camera on/off, screen share, raise hand,
reactions, and device selection. It is attached to a `Room` as `room.controls`
and is fully injectable (media provider functions) so it is unit-testable in
Node (`packages/core/test/controls.test.ts`).

```ts
const controls = room.controls;
await controls.toggleCamera(); // publish the camera
await controls.setMicrophoneMuted(true); // mute (peers hear silence)
await controls.toggleScreenShare(); // share the screen
await controls.raiseHand(); // sends a '✋' reaction
controls.on('mic-muted', (muted) => setMicButton(muted));
```

---

## 1. State and events

The manager exposes a single state snapshot plus typed events:

```ts
interface ControlsState {
  micMuted: boolean; // track still published, enabled=false
  cameraMuted: boolean; // track still published, enabled=false
  cameraPublishing: boolean; // a camera video track is published
  screenSharing: boolean; // a screen track is published
  handRaised: boolean; // local raise-hand flag
  devices: {
    audioinput: MediaDeviceInfo[];
    videoinput: MediaDeviceInfo[];
    audiooutput: MediaDeviceInfo[];
  };
}
```

Events (`controls.on(...)` — returns an unsubscribe function):

| Event                  | Args                                                     | Meaning                                            |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `mic-muted`            | `boolean`                                                | mic mute state changed (`true` = muted)            |
| `camera-muted`         | `boolean`                                                | camera mute state changed                          |
| `camera-published`     | `boolean`                                                | camera publish state changed (`true` = publishing) |
| `screen-share-started` | `{ track, label? }`                                      | screen share began                                 |
| `screen-share-stopped` | `{ reason: 'user' \| 'track-ended' \| 'error', error? }` | screen share ended                                 |
| `device-selected`      | `{ kind, deviceId }`                                     | a capture device was selected                      |
| `devices-changed`      | `MediaDeviceInfo[]`                                      | platform `devicechange` fired and the list changed |
| `hand-raised`          | `boolean`                                                | local raise-hand flag changed                      |
| `error`                | `Error`                                                  | async failure (devicechange refresh, etc.)         |

---

## 2. Microphone mute/unmute

### 2.1 API

```ts
await controls.setMicrophoneMuted(true); // mute
await controls.toggleMicrophone(); // flip; returns the new state
const muted = controls.state.micMuted; // read
controls.on('mic-muted', (m) => updateMicButton(m));
```

### 2.2 What mute actually does

Mute is `MediaStreamTrack.enabled = false`, **not** an unpublish:

- The track stays published on every peer connection (no renegotiation).
- The encoder emits silence/comfort noise instead of audio — the remote keeps
  a healthy RTP stream (no "call dropped" heuristics, no PLC artifacts).
- The local `TrackPublication.muted` flag is kept in sync, and `mic-muted`
  fires so the app can update its UI.
- Remote participants can still see the participant; they just hear silence.

```
local:  setMicrophoneMuted(true)
        │  micTrack.enabled = false      (encoder → silence)
        │  publication.muted = true
        ▼
        emit 'mic-muted' true  ──►  app button state
remote: no signaling at all — the RTP stream continues with silence frames
```

Unmute is the reverse (`enabled = true`); the browser immediately resumes
encoding real audio.

### 2.3 Edge cases

- **Mute before join / before publish.** The mute flag is stored even when no
  mic track exists yet. When the track is acquired through the controls
  manager (`controls.startMicrophone()`), the pending mute is applied to the
  new track automatically:

  ```ts
  await controls.setMicrophoneMuted(true); // no track yet — flag stored
  await room.join();
  await controls.startMicrophone(); // track comes up muted
  ```

  If the app publishes the mic itself via `room.publish(track)`, call
  `setMicrophoneMuted` after publishing (it applies to the live track).

- **Mute survives device switches and republish.** `setCameraDevice`/
  `setMicrophoneDevice` re-applies the muted flag to the replacement track.
- **Permission denied.** `getUserMedia` rejects (`NotAllowedError`); the
  promise propagates and nothing is published. Surface the error to the user.
- **Track ended (device unplugged).** The publication's `track` becomes
  `null`/ended; the mute flag persists so a re-acquired track starts muted.

---

## 3. Camera on/off and camera mute

Camera control is split into two independent concepts — do not conflate them:

| Action     | API                                         | Effect                                             |
| ---------- | ------------------------------------------- | -------------------------------------------------- |
| **Mute**   | `setCameraMuted(m)` / `toggleCameraMuted()` | `enabled=false`: black frames, no renegotiation    |
| **On/off** | `toggleCamera()` / `stopCamera()`           | publish/unpublish the camera track (renegotiation) |

### 3.1 API

```ts
const on = await controls.toggleCamera(); // publish via getUserMedia
controls.on('camera-published', (on) => updateCameraTile(on));

await controls.setCameraMuted(true); // black frames (still published)
await controls.toggleCamera(); // unpublish + stop the track
```

### 3.2 Publish flow

```
toggleCamera() → true
  getUserMedia({ video: preferredDevice | constraints })
  track.enabled = !cameraMuted          (mute-before-publish applied)
  room.publish(track, { source: 'camera' })
  emit 'camera-published' true
  ──► renegotiation with every peer ──► remote ontrack → remote tile
```

`toggleCamera()` returns the new publishing state. `stopCamera()` unpublishes
and stops the local track (freeing the camera light).

### 3.3 Edge cases

- **Camera mute + camera off are independent.** You can mute the camera while
  it is off — the flag persists and the next `toggleCamera()` publishes a
  muted (black) track.
- **Screen share interplay.** If the screen share is in _replace mode_ (see
  §4) and you call `stopCamera()`, the share is stopped first so the camera
  track can be restored, then the camera is unpublished. To keep camera +
  screen simultaneously, publish the screen track yourself via
  `room.publish(track, { source: 'screen' })` instead of
  `controls.toggleScreenShare()`.
- **iOS Safari.** `getUserMedia` requires a user gesture; the camera stops
  when the tab backgrounds. Rendering remote video needs `playsinline` on
  `<video>` elements.

---

## 4. Screen share

### 4.1 API

```ts
const sharing = await controls.toggleScreenShare(); // start/stop
await controls.startScreenShare();
await controls.stopScreenShare('user');
controls.on('screen-share-started', ({ track }) => showShareBadge());
controls.on('screen-share-stopped', ({ reason }) => hideShareBadge(reason));
```

### 4.2 Two publication modes

`toggleScreenShare()` picks a mode automatically:

1. **Replace mode (camera published):** the display track is swapped onto the
   camera's `RTCRtpSender`s with `RTCRtpSender.replaceTrack()` — **zero
   renegotiation**. The remote keeps the same video m-line; its track object
   does not change, only the content (the `screen-share` envelope tells the
   app this video is now a screen share). When sharing stops, the camera
   track is swapped back.

   ```
   startScreenShare()
     getDisplayMedia({ video: true })            // browser picker
     every peer: sender.replaceTrack(displayTrack)  // no SDP exchange
     announce 'screen-share' start               // wire envelope
     emit 'screen-share-started'
     displayTrack.onended → stopScreenShare('track-ended')
   ```

2. **Separate mode (no camera):** the display track is published as a new
   `screen` publication (new m-line, one renegotiation). The remote sees a
   new video track and the `screen-share` envelope.

### 4.3 Stop paths

| Path                                                       | How                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| App calls `stopScreenShare()` / `toggleScreenShare()`      | restore camera (replace mode) or unpublish (separate mode), stop the display track, announce `stop` |
| User clicks the browser's native **"Stop sharing"** button | `displayTrack.onended` fires → automatic `stopScreenShare('track-ended')`                           |
| Error mid-capture                                          | `getDisplayMedia` rejects → nothing published, error propagates                                     |

### 4.4 Edge cases

- **iOS Safari has no `getDisplayMedia`** — screen share is unsupported there;
  feature-detect and hide the button (`'getDisplayMedia' in navigator.mediaDevices`).
- **Camera + screen at the same time:** use `room.publish` for one of them;
  `controls.toggleScreenShare()` deliberately reuses the camera slot to avoid
  renegotiation.
- **Track replacement:** `replaceTrack` keeps the same m-line/SSRC stream, so
  the remote's publication bookkeeping is untouched; the `screen-share`
  envelope is the source of truth for what the video actually shows.

---

## 5. Raise hand and reactions

The wire protocol already defines reaction payloads
(`ReactionPayload { emoji, targetSenderId, ts }`); the controls manager
reuses them rather than inventing new message types.

```ts
await controls.raiseHand(); // sends a '✋' reaction + sets local flag
await controls.lowerHand(); // clears the local flag
await controls.toggleHand(); // flip; returns the new state
await controls.sendReaction('🎉', 'b'); // any emoji, optionally targeted

controls.on('hand-raised', (raised) => updateHandButton(raised));
room.on('reaction', (e) => showFloatingEmoji(e.emoji, e.participantId));
```

Flow:

```
raiseHand()
  room.sendReaction('✋')      ──►  wire envelope → every peer renders the overlay
  handRaised = true           ──►  emit 'hand-raised' true → local button state
```

Notes:

- `handRaised` is a **local** flag; peers see the reaction overlay, not a
  structured "hand" state. Apps that need a persistent hand list can track
  `✋` reactions per participant.
- The default raise-hand emoji is `✋` (`RAISE_HAND_EMOJI`); override it with
  `new ControlsManager(room, { raiseHandEmoji: '🙋' })`.
- Reactions also flow over the per-peer data channel (`DataChannelBus`) for
  lower latency when peer connections are up.

---

## 6. Device selection and `devicechange`

### 6.1 Listing devices

```ts
const devices = await controls.listDevices();
controls.state.devices; // { audioinput: [...], videoinput: [...], audiooutput: [...] }
controls.on('devices-changed', (all) => rebuildDeviceMenus(all));
```

The manager subscribes to the platform `devicechange` event at construction
(injectable), refreshes the categorized list, and emits `devices-changed`
only when the list actually changed (a plug/unplug doesn't spam listeners).
`dispose()` (called with the room's teardown) unsubscribes.

### 6.2 Selecting a device

```ts
await controls.setMicrophoneDevice('mic-2');
await controls.setCameraDevice('cam-9');
```

Strategy, per device kind:

1. **`applyConstraints({ deviceId: { exact } })` on the live track** — no
   renegotiation, no capture restart. Supported for video in Chromium-family
   browsers and for audio in most modern browsers.
2. **Fallback: re-acquire + `replaceTrack`.** If the browser rejects the
   constraint (`NotSupportedError`), the manager re-runs `getUserMedia` with
   the new `deviceId`, swaps the track onto every sender with
   `RTCRtpSender.replaceTrack()`, stops the old track, and updates the
   publication (preserving the muted flag).
3. **No live track yet:** the choice is remembered and applied to the _next_
   acquisition (`startMicrophone` / `startCamera` use the preferred device).

```ts
await controls.setCameraDevice('cam-9'); // before any camera exists
await controls.toggleCamera(); // getUserMedia({ video: { deviceId: { exact: 'cam-9' } } })
```

`device-selected` fires on every successful switch.

### 6.3 Relationship to `room.devices`

`Room` also exposes a lower-level devices facade (`room.devices`,
`packages/core/src/devices.ts`) with `listDevices(kind)`, `switchCamera()`
(front/back via `facingMode`), and `restartTrack(kind, { deviceId })`.
`room.controls` is the higher-level convenience (mute-aware, publication-aware,
reaction/raise-hand surface); `room.devices` is the platform-facing utility
(guarded, envelope-free). Both share the same underlying
`navigator.mediaDevices` seam and are injectable for tests.

---

## 7. Echo and audio quality

The default audio constraints applied by the controls manager
(`DEFAULT_AUDIO_CONSTRAINTS`) request the browser's acoustic echo canceller,
noise suppression, and auto-gain control:

```ts
{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }
```

- **Never disable echo cancellation** on the _local_ mic in a call; the
  browser AEC (libwebrtc audio processing) is the first line of defense.
- **Don't play remote audio near the mic** (speakerphone setups) — keep
  output on headphones when possible; AEC handles moderate leakage.
- **Safari/iOS AEC quirks** are real: echo at call start or after
  mute/unmute cycles is a known WebKit issue. Community workarounds: delay
  audio start a couple of seconds after `getUserMedia`, or re-toggle the mute
  once. vidcall's mute implementation (`enabled=false`) is the least
  disruptive way to do that (no renegotiation, no track restart).
- Callers can override constraints per acquisition:
  `controls.startMicrophone({ echoCancellation: true, noiseSuppression: false })`.

---

## 8. Full lifecycle example

```ts
import { Room } from '@mbsks/openrtc-core';
import { SupabaseBackend } from '@mbsks/openrtc-backend-supabase';

const room = new Room({
  roomId: 'room-abc',
  selfId: 'user-42',
  transport: new SupabaseBackend({ url, anonKey }),
});
const controls = room.controls; // wired by @mbsks/openrtc-core

controls.on('mic-muted', (m) => micButton.update(m));
controls.on('camera-published', (on) => camButton.update(on));
controls.on('screen-share-started', () => shareBadge.show());
controls.on('screen-share-stopped', ({ reason }) => shareBadge.hide(reason));
controls.on('devices-changed', () => void refreshDeviceMenus());

await room.join();
await controls.startMicrophone();
await controls.toggleCamera();

// Toolbar handlers
micButton.onClick = () => controls.toggleMicrophone();
camButton.onClick = () => controls.toggleCamera();
shareButton.onClick = () => controls.toggleScreenShare();
handButton.onClick = () => controls.toggleHand();

// Later
await room.leave(); // stops tracks, releases devicechange, closes peers
```

**Related:** `docs/features/call-models.md` (mesh/SFU topology — controls work
identically in both) · `docs/features/scaling.md` (SFU layer selection is the
receive-side counterpart of local mute/quality controls).
