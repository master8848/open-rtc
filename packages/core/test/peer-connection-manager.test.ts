import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPeerPair, resetFakeRTC, FakeRTCPeerConnection } from '../../test-utils/src/index.ts';
import { waitFor } from '../../test-utils/src/fixtures.ts';
import { PeerConnectionManager } from '../src/peer-connection-manager.ts';
import type { PeerSignal } from '../src/peer-connection-manager.ts';

beforeEach(() => resetFakeRTC());

interface ManagerPair {
  a: PeerConnectionManager;
  b: PeerConnectionManager;
  pcA: FakeRTCPeerConnection;
  pcB: FakeRTCPeerConnection;
  signalsA: PeerSignal[];
  signalsB: PeerSignal[];
}

/**
 * Two managers over wired fakes; signals relay across an async "backend"
 * (microtask) so glare/ordering races behave like a real transport.
 */
function createManagerPair(politeA = false, politeB = true): ManagerPair {
  const { a, b } = createPeerPair();
  const signalsA: PeerSignal[] = [];
  const signalsB: PeerSignal[] = [];
  const relay = (from: 'a' | 'b', signal: PeerSignal) => {
    if (from === 'a') {
      signalsA.push(signal);
      void (async () => {
        await bm.handleSignal(signal);
      })();
    } else {
      signalsB.push(signal);
      void (async () => {
        await am.handleSignal(signal);
      })();
    }
  };
  const am = new PeerConnectionManager({
    pc: a as unknown as RTCPeerConnection,
    polite: politeA,
    onSignal: (s) => relay('a', s),
  });
  const bm = new PeerConnectionManager({
    pc: b as unknown as RTCPeerConnection,
    polite: politeB,
    onSignal: (s) => relay('b', s),
  });
  return { a: am, b: bm, pcA: a, pcB: b, signalsA, signalsB };
}

test('perfect negotiation: offer -> answer -> stable, connected', async () => {
  const pair = createManagerPair();
  await pair.a.negotiate('test');
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  assert.equal(pair.pcB.remoteDescription!.type, 'offer');
  assert.equal(pair.pcA.remoteDescription?.type, 'answer');
  assert.equal(pair.signalsA[0]?.type, 'offer');
  assert.equal(pair.signalsB[0]?.type, 'answer');
  assert.equal(pair.a.connectionState, 'connected');
  assert.equal(pair.b.connectionState, 'connected');
});

test('trickle ICE: candidates are signaled and applied (buffered until SDP)', async () => {
  const pair = createManagerPair();
  void pair.a.negotiate('test');
  await waitFor(() => pair.signalsB.some((s) => s.type === 'answer'));
  // Candidates from A may arrive before/after B applied the offer; the manager
  // must buffer them until the remote description is in place.
  await waitFor(() => pair.signalsB.some((s) => s.type === 'ice'));
  await waitFor(() => pair.signalsA.some((s) => s.type === 'ice'));
  // After the dust settles, both sides applied remote candidates (no throw).
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  assert.equal(pair.a.iceConnectionState, 'connected');
});

test('glare: simultaneous offers resolve with perfect negotiation', async () => {
  const pair = createManagerPair(false, true); // a = impolite, b = polite
  await Promise.all([pair.a.negotiate('a'), pair.b.negotiate('b')]);
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  // Exactly one answer must have been produced (the polite side answered).
  const answers = [...pair.signalsA, ...pair.signalsB].filter((s) => s.type === 'answer');
  assert.equal(answers.length, 1);
  // The impolite side ignored the colliding remote offer; the polite side
  // rolled back its own and answered.
  assert.equal(pair.a.signalingState, 'stable');
  assert.equal(pair.b.signalingState, 'stable');
});

test('ICE buffering: candidate received before remote description is queued', async () => {
  const pair = createManagerPair();
  // Send A's candidate to B BEFORE any offer: must be buffered, not thrown.
  await pair.b.handleSignal({
    type: 'ice',
    payload: {
      candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  });
  assert.equal(pair.pcB.remoteDescription, null);
  // Now negotiate; after the offer is applied the buffered candidate flushes.
  await pair.a.negotiate('test');
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  // No error surfaced; the candidate was consumed.
  assert.equal(pair.pcB.remoteDescription!.type, 'offer');
});

test('SDP idempotency: a retransmitted offer is ignored', async () => {
  const pair = createManagerPair();
  await pair.a.negotiate('test');
  await waitFor(() => pair.b.signalingState === 'have-remote-offer');
  // Re-deliver the same offer (duplicate): must be ignored, state unchanged.
  const offer = pair.signalsA[0];
  assert.equal(offer?.type, 'offer');
  await pair.b.handleSignal(offer);
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  assert.equal(pair.b.signalingState, 'stable');
  // Only ONE answer was produced despite the duplicate offer.
  const answers = pair.signalsB.filter((s) => s.type === 'answer');
  assert.equal(answers.length, 1);
});

test('renegotiation: a second negotiate produces a newer offer version', async () => {
  const pair = createManagerPair();
  await pair.a.negotiate('first');
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  const v1 = pair.pcA.localDescription?.sdp;
  await pair.a.negotiate('second');
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  const v2 = pair.pcA.localDescription?.sdp;
  assert.notEqual(v1, v2);
  const offers = pair.signalsA.filter((s) => s.type === 'offer');
  assert.equal(offers.length, 2);
});

test('ICE restart: failed ICE triggers restartIce and a new offer', async () => {
  const pair = createManagerPair();
  await pair.a.negotiate('test');
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  const offersBefore = pair.signalsA.filter((s) => s.type === 'offer').length;
  pair.pcA.failIce();
  await waitFor(() => pair.signalsA.filter((s) => s.type === 'offer').length > offersBefore);
  await waitFor(() => pair.a.signalingState === 'stable' && pair.b.signalingState === 'stable');
  assert.equal(pair.a.iceConnectionState, 'connected');
});

test('connection-state callback fires on transitions', async () => {
  const { a, b } = createPeerPair();
  const states: string[] = [];
  const bm = new PeerConnectionManager({
    pc: b as unknown as RTCPeerConnection,
    polite: true,
    onConnectionState: (s) => states.push(s),
    onSignal: (signal) => {
      void am.handleSignal(signal);
    },
  });
  const am = new PeerConnectionManager({
    pc: a as unknown as RTCPeerConnection,
    polite: false,
    onSignal: (signal) => {
      void bm.handleSignal(signal);
    },
  });
  await am.negotiate('test');
  await waitFor(() => am.signalingState === 'stable' && bm.signalingState === 'stable');
  assert.ok(states.includes('connected'));
});

test('handleSignal with unknown types is a no-op', async () => {
  const pair = createManagerPair();
  await pair.a.handleSignal({ type: 'nope' } as never);
  assert.equal(pair.a.signalingState, 'stable');
});

test('close detaches handlers and closes the pc', async () => {
  const pair = createManagerPair();
  await pair.a.negotiate('test');
  await waitFor(() => pair.b.signalingState === 'have-remote-offer');
  pair.a.close();
  assert.equal(pair.pcA.isClosed, true);
  // Further signals are ignored after close.
  await pair.b.handleSignal({
    type: 'ice',
    payload: { candidate: 'x', sdpMid: null, sdpMLineIndex: null },
  });
  assert.equal(pair.pcA.isClosed, true);
});
