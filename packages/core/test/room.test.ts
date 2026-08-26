import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import {
  FakeRTCPeerConnection,
  FakeMediaStreamTrack,
  resetFakeRTC,
  asFake,
} from '../../test-utils/src/index.ts';
import { waitFor } from '../../test-utils/src/fixtures.ts';

beforeEach(() => resetFakeRTC());

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

function makeRoom(
  id: string,
  factory: (remoteId: string) => RTCPeerConnection,
  transport?: InMemoryTransport,
): { room: Room; transport: InMemoryTransport } {
  const t = transport ?? new InMemoryTransport();
  const room = new Room({
    roomId: 'room-1',
    selfId: id,
    displayName: `User ${id}`,
    transport: t,
    peerFactory: factory,
  });
  return { room, transport: t };
}

function makeRoomPair(): {
  a: { room: Room; transport: InMemoryTransport };
  b: { room: Room; transport: InMemoryTransport };
} {
  const factories = wiredPeerFactories();
  const a = makeRoom('a', factories('a'));
  const b = makeRoom('b', factories('b'));
  return { a, b };
}

test('Room: two peers join and see each other', async () => {
  const { a, b } = makeRoomPair();
  const aSees: string[] = [];
  a.room.on('participant-joined', (p) => aSees.push(p.id));
  const bSees: string[] = [];
  b.room.on('participant-joined', (p) => bSees.push(p.id));

  await a.room.join();
  await b.room.join();
  await waitFor(() => aSees.includes('b') && bSees.includes('a'));

  assert.deepEqual(aSees, ['b']);
  assert.deepEqual(bSees, ['a']);
  assert.equal(a.room.getParticipant('b')?.displayName, 'User b');
  assert.equal(b.room.getParticipant('a')?.displayName, 'User a');
  await a.room.leave();
  await b.room.leave();
});

test('Room: publish delivers the remote track and reports connection state', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const remoteTracks: { participantId: string; kind: string }[] = [];
  b.room.on('track', (e) =>
    remoteTracks.push({ participantId: e.participant.id, kind: e.track.kind }),
  );
  const states: string[] = [];
  b.room.on('connection-state', (e) => states.push(e.state));

  const track = new FakeMediaStreamTrack('video');
  await a.room.publish(track);
  await waitFor(() => remoteTracks.length === 1);

  assert.equal(remoteTracks[0]!.participantId, 'a');
  assert.equal(remoteTracks[0]!.kind, 'video');
  assert.equal(a.room.local.publications.length, 1);
  const bPub = b.room.getParticipant('a')!.publications[0]!;
  assert.equal(bPub.track, track);
  await waitFor(() => states.includes('connected'));
  assert.equal(b.room.getParticipant('a')?.connectionState, 'connected');
  await a.room.leave();
  await b.room.leave();
});

test('Room: reactions and chat broadcast over signaling', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const reactions: string[] = [];
  const chats: string[] = [];
  b.room.on('reaction', (e) => reactions.push(e.emoji));
  b.room.on('chat', (e) => chats.push(e.text));

  await a.room.sendReaction('🎉', 'b');
  await a.room.sendChat('hi there');
  await waitFor(() => reactions.length === 1 && chats.length === 1);
  assert.deepEqual(reactions, ['🎉']);
  assert.deepEqual(chats, ['hi there']);
  await a.room.leave();
  await b.room.leave();
});

test('Room: presence updates flow through', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const states: string[] = [];
  b.room.on('presence', (p) => states.push(p.state));
  await a.room.setPresence('away', { note: 'brb' });
  await waitFor(() => states.includes('away'));
  assert.equal(b.room.getParticipant('a')?.presence, 'away');
  await a.room.leave();
  await b.room.leave();
});

test('Room: leave announces and removes the participant', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!b.room.getParticipant('a'));

  const left: string[] = [];
  b.room.on('participant-left', (p) => left.push(p.id));
  await a.room.leave();
  await waitFor(() => left.includes('a'));
  assert.equal(b.room.getParticipant('a'), undefined);
  assert.equal(b.room.isClosed, false);
  await b.room.leave();
  assert.equal(b.room.isClosed, true);
});

test('Room: publish -> unpublish triggers renegotiation and track-unpublished', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const track = new FakeMediaStreamTrack('video');
  const pub = await a.room.publish(track);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  const unpublished: string[] = [];
  b.room.on('track-unpublished', (e) => unpublished.push(e.publication.id));
  await a.room.unpublish(pub);
  await waitFor(() => unpublished.length === 1);
  assert.equal(a.room.local.publications.length, 0);
  await a.room.leave();
  await b.room.leave();
});

test('Room: ICE restart renegotiates with a fresh offer', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const track = new FakeMediaStreamTrack('video');
  await a.room.publish(track);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  const pcA = asFake(a.room.getPeerConnection('b')!);
  const sdpBefore = pcA.localDescription?.sdp;
  await a.room.restartIce('b');
  await waitFor(() => pcA.localDescription?.sdp !== sdpBefore);
  await waitFor(() => pcA.iceConnectionState === 'connected');
  await a.room.leave();
  await b.room.leave();
});

test('Room: data channel bus is created per peer and forwards bus events', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  // Publish to force a peer connection + data channel negotiation.
  const track = new FakeMediaStreamTrack('video');
  await a.room.publish(track);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  const busB = b.room.getDataChannelBus('a') as unknown as { isOpen: boolean; sendReaction: (emoji: string) => void };
  assert.ok(busB, 'bus exists');
  await waitFor(() => busB.isOpen, { timeoutMs: 3000, message: 'datachannel opens' });

  const reactions: string[] = [];
  b.room.on('reaction', (e) => reactions.push(e.emoji));
  const busA = a.room.getDataChannelBus('b')! as unknown as { isOpen: boolean; sendReaction: (emoji: string) => void };
  await waitFor(() => busA.isOpen, { timeoutMs: 3000, message: 'a datachannel opens' });
  busA.sendReaction('🚀');
  await waitFor(() => reactions.includes('🚀'));
  assert.equal(reactions[0], '🚀');
  await a.room.leave();
  await b.room.leave();
});

test('Room: closed room rejects publish; leave is idempotent', async () => {
  const factories = wiredPeerFactories();
  const a = makeRoom('a', factories('a'));
  await a.room.join();
  await a.room.leave();
  await a.room.leave(); // idempotent
  await assert.rejects(() => a.room.publish(new FakeMediaStreamTrack('video')), /closed/);
});

test('Room: subscribe returns a control handle for remote tracks', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const track = new FakeMediaStreamTrack('video');
  await a.room.publish(track);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  const sub = await b.room.subscribe('a', { kind: 'video' });
  assert.equal(sub.publication?.track, track);
  sub.setEnabled(false);
  assert.equal(track.enabled, false);
  sub.setEnabled(true);
  assert.equal(track.enabled, true);
  await a.room.leave();
  await b.room.leave();
});
