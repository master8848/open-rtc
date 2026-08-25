import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { ControlsManager } from '../src/controls/ControlsManager.ts';
import type { ControlsMediaProvider } from '../src/controls/ControlsManager.ts';
import { RAISE_HAND_EMOJI } from '../src/controls/ControlsManager.ts';
import {
  FakeRTCPeerConnection,
  FakeMediaStreamTrack,
  resetFakeRTC,
  asFake,
} from '../../test-utils/src/index.ts';
import { FakeMediaStream } from '../../test-utils/src/fake-media-recorder.ts';
import { sleep, waitFor } from '../../test-utils/src/fixtures.ts';

beforeEach(() => resetFakeRTC());

// ---------------------------------------------------------------- helpers

/**
 * Factories that return WIRED fake peer connections for the (self, remote)
 * pair, so ICE/data-channel/track-end propagation behaves like a real mesh.
 */
function wiredPeerFactories() {
  const byKey = new Map<string, FakeRTCPeerConnection>();
  const wire = (k1: string, k2: string) => {
    const f1 = byKey.get(k1);
    const f2 = byKey.get(k2);
    if (f1 && f2) {
      f1.linkTo(f2);
      f2.linkTo(f1);
    }
  };
  return (selfId: string) =>
    (remoteId: string): RTCPeerConnection => {
      const key = `${selfId}->${remoteId}`;
      const existing = byKey.get(key);
      if (existing) return existing as unknown as RTCPeerConnection;
      const pc = new FakeRTCPeerConnection();
      byKey.set(key, pc);
      wire(key, `${remoteId}->${selfId}`);
      return pc as unknown as RTCPeerConnection;
    };
}

/** In-memory `ControlsMediaProvider` recording every call for assertions. */
class FakeMediaProvider implements ControlsMediaProvider {
  devices: MediaDeviceInfo[] = [];
  gumCalls: MediaStreamConstraints[] = [];
  gdmCalls: MediaStreamConstraints[] = [];
  failGetUserMedia = false;
  private readonly gumTracks: FakeMediaStreamTrack[] = [];
  private readonly gdmTracks: FakeMediaStreamTrack[] = [];
  private readonly listeners = new Set<() => void>();

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.gumCalls.push(constraints);
    if (this.failGetUserMedia) {
      throw new DOMException('Permission denied', 'NotAllowedError');
    }
    const tracks: FakeMediaStreamTrack[] = [];
    if (constraints.audio) tracks.push(new FakeMediaStreamTrack('audio', 'microphone'));
    if (constraints.video) tracks.push(new FakeMediaStreamTrack('video', 'camera'));
    this.gumTracks.push(...tracks);
    return new FakeMediaStream(tracks) as unknown as MediaStream;
  }

  async getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    this.gdmCalls.push(constraints ?? { video: true });
    const track = new FakeMediaStreamTrack('video', 'screen');
    this.gdmTracks.push(track);
    return new FakeMediaStream([track]) as unknown as MediaStream;
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices;
  }

  onDeviceChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Simulate the platform `devicechange` event. */
  fireDeviceChange(): void {
    for (const callback of [...this.listeners]) callback();
  }

  /** The most recent screen-share track (browser "Stop sharing" button). */
  get screenTrack(): FakeMediaStreamTrack {
    return this.gdmTracks[this.gdmTracks.length - 1]!;
  }

  /** All tracks handed out by getUserMedia (camera + mic), in order. */
  get gumTracksList(): FakeMediaStreamTrack[] {
    return [...this.gumTracks];
  }
}

function fakeDevice(kind: MediaDeviceKind, deviceId: string, label = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: 'group-1', toJSON: () => ({}) } as MediaDeviceInfo;
}

let roomCounter = 0;

interface ControlsRig {
  room: Room;
  controls: ControlsManager;
  media: FakeMediaProvider;
  transport: InMemoryTransport;
}

function makeControlsRoom(
  id: string,
  roomId: string,
  factory: (remoteId: string) => RTCPeerConnection,
  media: FakeMediaProvider,
): ControlsRig {
  const transport = new InMemoryTransport();
  const room = new Room({
    roomId,
    selfId: id,
    displayName: `User ${id}`,
    transport,
    peerFactory: factory,
  });
  // `room.controls` is wired by @mbsks/core's index; the constructor takes
  // the Room as a structurally-compatible ControlsHost.
  const controls = new ControlsManager(room, { mediaProvider: media });
  return { room, controls, media, transport };
}

function makePair(): { a: ControlsRig; b: ControlsRig } {
  const factories = wiredPeerFactories();
  // Unique roomId per pair: the in-memory transport registry is process-wide,
  // so a test that throws before leave() must not pollute later tests.
  const roomId = `room-${++roomCounter}`;
  const a = makeControlsRoom('a', roomId, factories('a'), new FakeMediaProvider());
  const b = makeControlsRoom('b', roomId, factories('b'), new FakeMediaProvider());
  return { a, b };
}

async function joinBoth(a: ControlsRig, b: ControlsRig): Promise<void> {
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));
}

function screenShareActions(room: Room): string[] {
  const actions: string[] = [];
  room.on('screen-share', (event) => actions.push(event.action));
  return actions;
}

function cameraPublication(room: Room) {
  return room.local.publications.find((p) => p.source === 'camera');
}

// ------------------------------------------------------------------ tests

test('ControlsManager: mic mute toggles track.enabled, publication.muted, and events', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  const publication = await a.controls.startMicrophone();
  assert.ok(publication, 'mic published');
  const track = publication!.track!;
  assert.equal(track.enabled, true);
  assert.equal(publication!.muted, false);
  // Remote peer received the (same fake) track.
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);
  const remoteTrack = b.room.getParticipant('a')!.publications[0]!.track!;

  const mutedEvents: boolean[] = [];
  a.controls.on('mic-muted', (muted) => mutedEvents.push(muted));
  assert.equal(await a.controls.setMicrophoneMuted(true), true);
  assert.equal(track.enabled, false);
  assert.equal(publication!.muted, true);
  assert.equal(a.controls.state.micMuted, true);
  assert.equal(remoteTrack.enabled, false, 'remote sees a disabled (silent) track');

  assert.equal(await a.controls.toggleMicrophone(), false);
  assert.equal(track.enabled, true);
  assert.equal(publication!.muted, false);
  assert.deepEqual(mutedEvents, [true, false]);
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: mute before publish applies when the mic is acquired', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  const mutedEvents: boolean[] = [];
  a.controls.on('mic-muted', (muted) => mutedEvents.push(muted));
  assert.equal(await a.controls.setMicrophoneMuted(true), true);
  assert.equal(a.room.local.publications.length, 0, 'no track needed to mute');

  const publication = await a.controls.startMicrophone();
  assert.equal(publication!.track!.enabled, false, 'pending mute applied on acquisition');
  assert.equal(publication!.muted, true);
  assert.deepEqual(mutedEvents, [true]);
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: toggleCamera publishes via getUserMedia then unpublishes', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  const publishedEvents: boolean[] = [];
  a.controls.on('camera-published', (publishing) => publishedEvents.push(publishing));

  assert.equal(await a.controls.toggleCamera(), true);
  const publication = cameraPublication(a.room);
  assert.ok(publication, 'camera publication exists');
  assert.equal(publication!.source, 'camera');
  assert.equal(publication!.kind, 'video');
  assert.equal(publication!.track!.enabled, true);
  assert.equal(a.controls.state.cameraPublishing, true);
  // getUserMedia was called with video constraints.
  assert.equal(a.media.gumCalls.length, 1);
  assert.ok((a.media.gumCalls[0]!.video as MediaTrackConstraints) !== undefined);

  // Remote peer received the camera track.
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);
  const remotePublication = b.room.getParticipant('a')!.publications[0]!;
  assert.equal(remotePublication.kind, 'video');

  const cameraTrack = publication!.track!;
  assert.equal(await a.controls.toggleCamera(), false);
  assert.equal(cameraPublication(a.room), undefined, 'camera unpublished');
  assert.equal(cameraTrack.readyState, 'ended', 'local track stopped');
  assert.equal(a.controls.state.cameraPublishing, false);
  assert.deepEqual(publishedEvents, [true, false]);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 0);
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: camera mute toggles track.enabled and survives republish', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  await a.controls.toggleCamera();
  const publication = cameraPublication(a.room)!;
  const mutedEvents: boolean[] = [];
  a.controls.on('camera-muted', (muted) => mutedEvents.push(muted));

  assert.equal(await a.controls.setCameraMuted(true), true);
  assert.equal(publication.track!.enabled, false);
  assert.equal(publication.muted, true);
  assert.equal(a.controls.state.cameraMuted, true);

  assert.equal(await a.controls.toggleCameraMuted(), false);
  assert.equal(publication.track!.enabled, true);
  assert.deepEqual(mutedEvents, [true, false]);

  // Mute flag survives an unpublish/republish cycle.
  await a.controls.setCameraMuted(true);
  await a.controls.toggleCamera();
  await a.controls.toggleCamera();
  const republished = cameraPublication(a.room)!;
  assert.equal(republished.track!.enabled, false, 'mute applied to the new track');
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: screen share replaces the camera track via replaceTrack (no renegotiation)', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  await a.controls.toggleCamera();
  const cameraTrack = cameraPublication(a.room)!.track!;
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  const pcA = asFake(a.room.getPeerConnection('b')!);
  const sdpBefore = pcA.localDescription?.sdp;
  const actionsB = screenShareActions(b.room);
  const started: unknown[] = [];
  a.controls.on('screen-share-started', (event) => started.push(event));

  assert.equal(await a.controls.startScreenShare(), true);
  assert.equal(a.controls.state.screenSharing, true);

  // The camera sender now carries the display track — no renegotiation.
  const screenSender = pcA.getSenders().find((s) => s.track !== cameraTrack);
  assert.ok(screenSender, 'a sender carries a different (screen) track');
  assert.equal(pcA.localDescription?.sdp, sdpBefore, 'replaceTrack avoided renegotiation');
  assert.equal(started.length, 1);
  await waitFor(() => actionsB.includes('start'));

  // Stopping restores the camera track on the same sender.
  const stopped: { reason: string }[] = [];
  a.controls.on('screen-share-stopped', (event) => stopped.push(event));
  assert.equal(await a.controls.stopScreenShare(), true);
  assert.equal(screenSender!.track, cameraTrack, 'camera track restored');
  assert.equal(a.controls.state.screenSharing, false);
  assert.equal(stopped[0]!.reason, 'user');
  await waitFor(() => actionsB.includes('stop'));
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: screen share without camera publishes a separate screen track', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  const actionsB = screenShareActions(b.room);
  const started: unknown[] = [];
  a.controls.on('screen-share-started', (event) => started.push(event));

  assert.equal(await a.controls.startScreenShare(), true);
  const screenPublication = a.room.local.publications.find((p) => p.source === 'screen');
  assert.ok(screenPublication, 'separate screen publication');
  assert.equal(screenPublication!.kind, 'video');
  assert.equal(started.length, 1);
  await waitFor(() => actionsB.includes('start'));
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);
  // The remote side models every incoming video track as a camera publication
  // (Room.handleRemoteTrack); the `screen-share` envelope (asserted above) is
  // what tells the app this video is actually a screen share.
  const remotePublication = b.room.getParticipant('a')!.publications[0]!;
  assert.equal(remotePublication.kind, 'video');

  const unpublished: string[] = [];
  b.room.on('track-unpublished', (event) => unpublished.push(event.publication.id));
  assert.equal(await a.controls.toggleScreenShare(), false);
  assert.equal(
    a.room.local.publications.find((p) => p.source === 'screen'),
    undefined,
  );
  assert.equal(a.controls.state.screenSharing, false);
  await waitFor(() => actionsB.includes('stop'));
  await waitFor(() => unpublished.length === 1);
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: browser stop-share button ends screen share automatically', async () => {
  // Single-room rig (no remote peer): the fake models a track's `onended` as
  // a single slot that the receiving room's own 'ended' listener would shadow
  // during renegotiation; real browsers support multiple listeners, so the
  // manager's listener always fires there. An observer transport still sees
  // the `screen-share` announce envelope on the wire.
  const factories = wiredPeerFactories();
  const a = makeControlsRoom('a', `room-${++roomCounter}`, factories('a'), new FakeMediaProvider());
  await a.room.join();
  const observer = new InMemoryTransport();
  await observer.join(a.room.roomId, { id: 'observer' });
  const announces: string[] = [];
  observer.onMessage((envelope) => {
    if (envelope.type === 'screen-share') {
      announces.push((envelope.payload as { action?: string } | undefined)?.action ?? '?');
    }
  });

  const stopped: { reason: string }[] = [];
  a.controls.on('screen-share-stopped', (event) => stopped.push(event));
  await a.controls.startScreenShare();
  assert.equal(a.controls.state.screenSharing, true);
  await waitFor(() => announces.includes('start'));

  // The user clicks the browser's native "Stop sharing" control.
  a.media.screenTrack.stop();

  await waitFor(() => stopped.length === 1);
  assert.equal(stopped[0]!.reason, 'track-ended');
  assert.equal(a.controls.state.screenSharing, false);
  await waitFor(() => announces.includes('stop'));
  assert.equal(a.media.screenTrack.readyState, 'ended');
  await a.room.leave();
  await observer.leave();
});

test('ControlsManager: raise hand and reactions reuse the wire reaction envelope', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  const reactions: { emoji: string; targetSenderId?: string }[] = [];
  b.room.on('reaction', (event) =>
    reactions.push({ emoji: event.emoji, targetSenderId: event.targetSenderId }),
  );
  const handEvents: boolean[] = [];
  a.controls.on('hand-raised', (raised) => handEvents.push(raised));

  assert.equal(await a.controls.raiseHand(), true);
  assert.equal(a.controls.state.handRaised, true);
  assert.equal(a.controls.handRaised, true);
  await waitFor(() => reactions.length === 1);
  assert.equal(reactions[0]!.emoji, RAISE_HAND_EMOJI);

  assert.equal(await a.controls.toggleHand(), false);
  assert.equal(a.controls.handRaised, false);
  assert.equal(await a.controls.toggleHand('b'), true);
  assert.equal(a.controls.handRaised, true);
  await waitFor(() => reactions.length === 2);
  assert.equal(reactions[1]!.targetSenderId, 'b');
  assert.deepEqual(handEvents, [true, false, true]);

  await a.controls.sendReaction('🎉', 'b');
  await waitFor(() => reactions.length === 3);
  assert.equal(reactions[2]!.emoji, '🎉');
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: listDevices categorizes and devicechange refreshes the list', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  a.media.devices = [
    fakeDevice('audioinput', 'mic-1', 'Built-in Microphone'),
    fakeDevice('videoinput', 'cam-1', 'FaceTime HD Camera'),
    fakeDevice('audiooutput', 'spk-1', 'Built-in Output'),
  ];
  const list = await a.controls.listDevices();
  assert.equal(list.length, 3);
  assert.equal(a.controls.state.devices.audioinput.length, 1);
  assert.equal(a.controls.state.devices.videoinput[0]!.deviceId, 'cam-1');
  assert.equal(a.controls.state.devices.audiooutput[0]!.label, 'Built-in Output');

  const changed: MediaDeviceInfo[][] = [];
  a.controls.on('devices-changed', (devices) => changed.push(devices));
  a.media.devices = [
    fakeDevice('audioinput', 'mic-2', 'USB Mic'),
    fakeDevice('videoinput', 'cam-1'),
  ];
  a.media.fireDeviceChange();
  await waitFor(() => changed.length === 1);
  assert.equal(a.controls.state.devices.audioinput[0]!.deviceId, 'mic-2');

  // No change event when the list is identical.
  a.media.fireDeviceChange();
  await sleep(10);
  assert.equal(changed.length, 1);

  // dispose() unsubscribes devicechange and is idempotent.
  a.controls.dispose();
  a.controls.dispose();
  const before = changed.length;
  a.media.devices = [fakeDevice('videoinput', 'cam-9')];
  a.media.fireDeviceChange();
  await sleep(10);
  assert.equal(changed.length, before);
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: setMicrophoneDevice applies constraints to the live track', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  const publication = await a.controls.startMicrophone();
  const track = publication!.track!;
  const applied: MediaTrackConstraints[] = [];
  track.applyConstraints = async (constraints) => {
    applied.push(constraints ?? {});
  };

  const selected: { kind: string; deviceId: string }[] = [];
  a.controls.on('device-selected', (event) => selected.push(event));
  await a.controls.setMicrophoneDevice('mic-2');

  assert.deepEqual(applied, [{ deviceId: { exact: 'mic-2' } }]);
  assert.deepEqual(selected, [{ kind: 'audioinput', deviceId: 'mic-2' }]);
  assert.equal(track.enabled, true, 'track untouched by applyConstraints path');
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: setCameraDevice re-acquires and replaceTracks when applyConstraints fails', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  await a.controls.toggleCamera();
  const publication = cameraPublication(a.room)!;
  const oldTrack = publication.track!;
  oldTrack.applyConstraints = async () => {
    throw new DOMException('deviceId switching not supported', 'NotSupportedError');
  };
  await a.controls.setCameraMuted(true);

  const selected: { kind: string; deviceId: string }[] = [];
  a.controls.on('device-selected', (event) => selected.push(event));
  await a.controls.setCameraDevice('cam-2');

  // Re-acquisition used the requested device.
  const gumCall = a.media.gumCalls[a.media.gumCalls.length - 1]!;
  assert.deepEqual((gumCall.video as MediaTrackConstraints).deviceId, { exact: 'cam-2' });
  // The sender now carries the new track; the old track was stopped.
  const pcA = asFake(a.room.getPeerConnection('b')!);
  const newTrack = a.media.gumTracksList[a.media.gumTracksList.length - 1]!;
  assert.equal(pcA.getSenders().find((s) => s.track === newTrack)?.track, newTrack);
  assert.equal(oldTrack.readyState, 'ended');
  assert.equal(publication.track, newTrack);
  assert.equal(newTrack.enabled, false, 'camera mute applied to the replacement track');
  assert.equal(publication.muted, true);
  assert.deepEqual(selected, [{ kind: 'videoinput', deviceId: 'cam-2' }]);
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: preferred device is used for later acquisition', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);

  await a.controls.setMicrophoneDevice('mic-9');
  await a.controls.setCameraDevice('cam-9');
  await a.controls.startMicrophone();
  // Room renegotiates per publish; wait for the mic negotiation to settle
  // (signalingState back to 'stable') before publishing the camera.
  await waitFor(() => asFake(a.room.getPeerConnection('b')!).signalingState === 'stable');
  await a.controls.startCamera();

  const micCall = a.media.gumCalls[0]!;
  assert.deepEqual((micCall.audio as MediaTrackConstraints).deviceId, { exact: 'mic-9' });
  assert.equal((micCall.audio as MediaTrackConstraints).echoCancellation, true);
  const camCall = a.media.gumCalls[1]!;
  assert.deepEqual((camCall.video as MediaTrackConstraints).deviceId, { exact: 'cam-9' });
  await a.room.leave();
  await b.room.leave();
});

test('ControlsManager: getUserMedia rejection propagates and publishes nothing', async () => {
  const { a, b } = makePair();
  await joinBoth(a, b);
  a.media.failGetUserMedia = true;

  await assert.rejects(() => a.controls.toggleCamera(), /Permission denied/);
  assert.equal(a.room.local.publications.length, 0);
  await a.room.leave();
  await b.room.leave();
});
