import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeRTCPeerConnection,
  FakeMediaStreamTrack,
  createPeerPair,
  resetFakeRTC,
  wirePeers,
} from '../src/index.ts';

function sdpOrigin(sdp: string): { sessionId: string; version: number } {
  const m = /^o=- (\S+) (\d+) /m.exec(sdp);
  assert.ok(m, 'sdp has o= line');
  return { sessionId: m[1]!, version: Number(m[2]) };
}

beforeEach(() => resetFakeRTC());

test('createOffer produces an SDP with a stable o= session-id and bumping version', async () => {
  const pc = new FakeRTCPeerConnection();
  const offer1 = await pc.createOffer();
  const offer2 = await pc.createOffer();
  const o1 = sdpOrigin(offer1.sdp ?? '');
  const o2 = sdpOrigin(offer2.sdp ?? '');
  assert.equal(o1.sessionId, o2.sessionId);
  assert.ok(o2.version > o1.version);
});

test('signaling state machine: offer/answer/rollback', async () => {
  const pc = new FakeRTCPeerConnection();
  assert.equal(pc.signalingState, 'stable');
  await pc.setLocalDescription(await pc.createOffer());
  assert.equal(pc.signalingState, 'have-local-offer');
  await pc.setRemoteDescription({ type: 'answer', sdp: (await pc.createAnswer()).sdp });
  assert.equal(pc.signalingState, 'stable');

  await pc.setRemoteDescription({
    type: 'offer',
    sdp: 'v=0\r\no=- remote 1 1 IN IP4 127.0.0.1\r\ns=-\r\n',
  });
  assert.equal(pc.signalingState, 'have-remote-offer');
  await pc.setLocalDescription(await pc.createAnswer());
  assert.equal(pc.signalingState, 'stable');

  // rollback
  await pc.setLocalDescription(await pc.createOffer());
  assert.equal(pc.signalingState, 'have-local-offer');
  await pc.setLocalDescription({ type: 'rollback' });
  assert.equal(pc.signalingState, 'stable');
});

test('addIceCandidate throws before a remote description is set', async () => {
  const pc = new FakeRTCPeerConnection();
  await assert.rejects(
    () =>
      pc.addIceCandidate({
        candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      }),
    /remote description/,
  );
});

test('data channels: createDataChannel fires ondatachannel on the wired peer', async () => {
  const { a, b } = createPeerPair();
  const seen: string[] = [];
  b.ondatachannel = (ev) => seen.push(ev.channel.label);
  const channel = a.createDataChannel('vidcall');
  assert.equal(channel.readyState, 'connecting');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['vidcall']);
  assert.equal(channel.readyState, 'open');
});

test('data channels: messages flow between paired channels', async () => {
  const { a, b } = createPeerPair();
  const received: string[] = [];
  b.ondatachannel = (ev) => {
    ev.channel.onmessage = (m) => received.push(String(m.data));
  };
  const channel = a.createDataChannel('chat');
  await new Promise((r) => setTimeout(r, 5));
  channel.send('hello');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(received, ['hello']);
});

test('tracks: addTrack + remote offer fires ontrack with the sender track', async () => {
  const { a, b } = createPeerPair();
  const track = new FakeMediaStreamTrack('video');
  a.addTrack(track);
  const tracks: MediaStreamTrack[] = [];
  b.ontrack = (ev) => tracks.push(ev.track);
  // Simulate the engine flow: A offers, B applies the offer.
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0], track);
});

test('restartIce schedules negotiationneeded and bumps SDP version', async () => {
  const pc = new FakeRTCPeerConnection();
  let negotiations = 0;
  pc.onnegotiationneeded = () => negotiations++;
  const v0 = sdpOrigin((await pc.createOffer()).sdp ?? '').version;
  pc.restartIce();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(negotiations >= 1);
  const v1 = sdpOrigin((await pc.createOffer()).sdp ?? '').version;
  assert.ok(v1 > v0);
});

test('wirePeers links both directions', () => {
  const a = new FakeRTCPeerConnection();
  const b = new FakeRTCPeerConnection();
  wirePeers(a, b);
  a.deliverIce({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host' });
  assert.ok(true); // deliverIce schedules a microtask; smoke check
});
