import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import {
  listDevices,
  switchCamera,
  setFacingMode,
  restartTrack,
  facingFromLabel,
  DevicesUnavailableError,
  type FacingMode,
} from '../src/devices.ts';
import {
  FakeMediaDevices,
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  FakeRTCRtpSender,
  resetFakeRTC,
  resetFakeMediaDevices,
} from '../../test-utils/src/index.ts';
import { waitFor } from '../../test-utils/src/fixtures.ts';

beforeEach(() => {
  resetFakeRTC();
  resetFakeMediaDevices();
});

/** FakeMediaStreamTrack that records applyConstraints and tracks facingMode. */
class FacingTrack extends FakeMediaStreamTrack {
  facing: FacingMode | undefined;
  readonly applied: MediaTrackConstraints[] = [];

  constructor(facing?: FacingMode) {
    super('video', 'camera');
    this.facing = facing;
  }

  override getSettings(): MediaTrackSettings {
    return { ...super.getSettings(), ...(this.facing ? { facingMode: this.facing } : {}) };
  }

  override applyConstraints(constraints?: MediaTrackConstraints): Promise<void> {
    this.applied.push(constraints ?? {});
    if (constraints?.facingMode) this.facing = constraints.facingMode as FacingMode;
    return Promise.resolve();
  }
}

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

function makeRoom(
  id: string,
  factory: (remoteId: string) => RTCPeerConnection,
  extra: Partial<ConstructorParameters<typeof Room>[0]> = {},
): { room: Room; transport: InMemoryTransport } {
  const transport = new InMemoryTransport();
  const room = new Room({
    roomId: 'room-1',
    selfId: id,
    displayName: `User ${id}`,
    transport,
    peerFactory: factory,
    ...extra,
  });
  return { room, transport };
}

test('devices.listDevices: enumerates, filters by kind, derives facing hints', async () => {
  const fake = new FakeMediaDevices();
  fake.devices = [
    { deviceId: 'front-cam', kind: 'videoinput', label: 'Front Camera', groupId: 'g1' },
    { deviceId: 'back-cam', kind: 'videoinput', label: 'Back Camera', groupId: 'g1' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone', groupId: 'g2' },
    { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Speaker', groupId: 'g2' },
  ];

  const all = await listDevices(undefined, fake);
  assert.equal(all.length, 4);
  assert.deepEqual(
    all.map((d) => d.kind),
    ['videoinput', 'videoinput', 'audioinput', 'audiooutput'],
  );

  const cams = await listDevices('videoinput', fake);
  assert.deepEqual(
    cams.map((d) => d.deviceId),
    ['front-cam', 'back-cam'],
  );
  assert.equal(cams[0]!.facing, 'user');
  assert.equal(cams[1]!.facing, 'environment');
  assert.equal(cams[0]!.groupId, 'g1');

  const mics = await listDevices('audioinput', fake);
  assert.equal(mics.length, 1);
  assert.equal(mics[0]!.deviceId, 'mic-1');
  assert.equal(mics[0]!.groupId, 'g2');
  assert.equal(mics[0]!.facing, undefined);
});

test('devices.facingFromLabel: label heuristics', () => {
  assert.equal(facingFromLabel('Back Camera'), 'environment');
  assert.equal(facingFromLabel('rear camera'), 'environment');
  assert.equal(facingFromLabel('Front Camera'), 'user');
  assert.equal(facingFromLabel('Selfie cam'), 'user');
  assert.equal(facingFromLabel('USB Audio Device'), undefined);
});

test('devices.listDevices: unavailable environment resolves []', async () => {
  assert.deepEqual(await listDevices(undefined, null), []);
  assert.deepEqual(await listDevices('videoinput', undefined), []);
});

test('devices.switchCamera: toggles facingMode user <-> environment', async () => {
  const front = new FacingTrack('user');
  const back = new FacingTrack('environment');
  const desktop = new FacingTrack(undefined);

  assert.equal(await switchCamera([front, back, desktop]), true);
  assert.deepEqual(front.applied, [{ facingMode: 'environment' }]);
  assert.deepEqual(back.applied, [{ facingMode: 'user' }]);
  assert.deepEqual(desktop.applied, [{ facingMode: 'environment' }]);

  // Second toggle flips back.
  assert.equal(await switchCamera([front]), true);
  assert.deepEqual(front.applied[1], { facingMode: 'user' });

  // No video tracks -> not switched.
  assert.equal(await switchCamera([new FakeMediaStreamTrack('audio')]), false);
  assert.equal(await switchCamera([]), false);
});

test('devices.setFacingMode: applies the explicit mode', async () => {
  const track = new FacingTrack('user');
  assert.equal(await setFacingMode([track], 'environment'), true);
  assert.deepEqual(track.applied, [{ facingMode: 'environment' }]);
  assert.equal(track.facing, 'environment');

  // Audio tracks are ignored.
  assert.equal(await setFacingMode([new FakeMediaStreamTrack('audio')], 'user'), false);
});

test('devices.restartTrack: getUserMedia(new deviceId) + replaceTrack preserves enabled state', async () => {
  const fake = new FakeMediaDevices();
  fake.devices = [
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone' },
    { deviceId: 'mic-2', kind: 'audioinput', label: 'Headset' },
  ];

  const oldTrack = new FakeMediaStreamTrack('audio', 'Microphone');
  oldTrack.enabled = false; // muted
  const sender = new FakeRTCRtpSender(oldTrack);
  const videoSender = new FakeRTCRtpSender(new FakeMediaStreamTrack('video'));

  const newTrack = await restartTrack('audio', { deviceId: 'mic-2' }, fake, [sender, videoSender]);

  assert.equal(newTrack.kind, 'audio');
  assert.equal(newTrack.label, 'Headset'); // track came from the requested device
  assert.equal(newTrack.enabled, false); // mute state preserved
  assert.equal(sender.track, newTrack); // sender replaced
  assert.equal(videoSender.track!.kind, 'video'); // other senders untouched
  assert.equal(oldTrack.readyState, 'ended'); // old track stopped
  assert.deepEqual(fake.lastConstraints, {
    audio: { deviceId: { exact: 'mic-2' } },
    video: false,
  });
});

test('devices.restartTrack: unavailable environment and no-sender guards', async () => {
  await assert.rejects(
    () => restartTrack('video', { deviceId: 'x' }, null, []),
    DevicesUnavailableError,
  );
  await assert.rejects(
    () => restartTrack('audio', { deviceId: 'x' }, new FakeMediaDevices(), []),
    /no local 'audio' sender/,
  );
});

test('Room.devices: facade wires provider, devices:changed events, lifecycle cleanup', async () => {
  const fake = new FakeMediaDevices();
  fake.devices = [
    { deviceId: 'front-cam', kind: 'videoinput', label: 'Front Camera' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone' },
  ];
  const { room } = makeRoom(
    'me',
    () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection,
    { devices: { mediaDevices: fake } },
  );

  const roomEvents: number[] = [];
  room.on('devices:changed', () => roomEvents.push(1));
  const facadeEvents: number[] = [];
  room.devices.on('devices:changed', () => facadeEvents.push(1));

  // Subscribed at construction (before join).
  assert.equal(fake.deviceChangeListenerCount(), 1);

  const cams = await room.devices.listDevices('videoinput');
  assert.equal(cams.length, 1);
  assert.equal(cams[0]!.deviceId, 'front-cam');
  assert.equal(cams[0]!.facing, 'user');
  assert.equal((await room.devices.listDevices('audioinput'))[0]!.deviceId, 'mic-1');

  fake.fireDeviceChange();
  assert.equal(roomEvents.length, 1);
  assert.equal(facadeEvents.length, 1);

  // leave() removes the devicechange subscription -> no further events.
  await room.leave();
  assert.equal(fake.deviceChangeListenerCount(), 0);
  fake.fireDeviceChange();
  assert.equal(roomEvents.length, 1);
  assert.equal(facadeEvents.length, 1);
});

test('Room.devices: restartTrack swaps the track on every sender, preserving mute', async () => {
  const fake = new FakeMediaDevices();
  fake.devices = [
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone' },
    { deviceId: 'mic-2', kind: 'audioinput', label: 'Headset' },
  ];
  const factories = wiredPeerFactories();
  const a = makeRoom('a', factories('a'), { devices: { mediaDevices: fake } });
  const b = makeRoom('b', factories('b'));
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const mic = new FakeMediaStreamTrack('audio', 'Microphone');
  mic.enabled = false; // muted
  await a.room.publish(mic);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);
  assert.equal(a.room.getPeerConnection('b')!.getSenders()[0]!.track, mic);

  const newTrack = await a.room.devices.restartTrack('audio', { deviceId: 'mic-2' });
  assert.equal(newTrack.kind, 'audio');
  assert.equal(newTrack.enabled, false); // mute preserved across the swap
  assert.equal(a.room.getPeerConnection('b')!.getSenders()[0]!.track, newTrack);
  assert.equal(a.room.local.publications[0]!.track, newTrack); // publication bookkeeping
  assert.equal(mic.readyState, 'ended'); // old track stopped

  await a.room.leave();
  await b.room.leave();
});

test('Room.devices: unavailable environment is guarded through the facade', async () => {
  const { room } = makeRoom(
    'me',
    () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection,
    { devices: { mediaDevices: null } },
  );
  assert.deepEqual(await room.devices.listDevices(), []);
  assert.equal(await room.devices.switchCamera(), false); // no local video tracks
  assert.equal(await room.devices.setFacingMode('user'), false);
  await assert.rejects(
    () => room.devices.restartTrack('video', { deviceId: 'x' }),
    DevicesUnavailableError,
  );
  await room.leave();
});

test('Room.devices: switchCamera acts on published local video tracks', async () => {
  const factories = wiredPeerFactories();
  const a = makeRoom('a', factories('a'));
  const b = makeRoom('b', factories('b'));
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const camera = new FacingTrack('user');
  await a.room.publish(camera);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  assert.equal(await a.room.devices.switchCamera(), true);
  assert.deepEqual(camera.applied, [{ facingMode: 'environment' }]);
  assert.equal(await a.room.devices.setFacingMode('user'), true);
  assert.deepEqual(camera.applied[1], { facingMode: 'user' });

  await a.room.leave();
  await b.room.leave();
});
