/**
 * SfuRouter envelope handling + SfuGateway contract tests (pure logic; no
 * media involved — a fake gateway/session records calls).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnvelope,
  type Envelope,
  type IcePayload,
  type OfferPayload,
  type SfuPayload,
} from '@vidcall/protocol';
import { SfuRouter, type SfuRouterErrorCode } from '../src/sfu-router.ts';
import type {
  PublishOptions,
  SfuGateway,
  SfuJoinOptions,
  SfuSession,
  SfuTrackEvent,
  SubscribeOptions,
} from '../src/sfu-gateway.ts';

// ------------------------------------------------------------------ fakes

/** Records every call a session receives; settles immediately. */
class FakeSession implements SfuSession {
  readonly roomId: string;
  readonly participantId: string;
  readonly calls: string[] = [];
  published: Array<{ trackId: string; kind: string; opts?: PublishOptions }> = [];
  subscribed: string[] = [];
  layers: Array<{ trackId: string; layer: string }> = [];
  keyframes: string[] = [];
  offers: OfferPayload[] = [];
  answers: OfferPayload[] = [];
  candidates: IcePayload[] = [];
  left = false;

  constructor(roomId: string, participantId: string) {
    this.roomId = roomId;
    this.participantId = participantId;
  }

  async publishTrack(
    trackId: string,
    kind: 'audio' | 'video' | 'screen',
    opts?: PublishOptions,
  ): Promise<void> {
    this.calls.push(`publish:${trackId}`);
    this.published.push({ trackId, kind, opts });
  }
  async subscribe(participantId: string, _opts?: SubscribeOptions): Promise<void> {
    this.calls.push(`subscribe:${participantId}`);
    this.subscribed.push(participantId);
  }
  async setPreferredLayers(trackId: string, layer: string): Promise<void> {
    this.calls.push(`layer:${trackId}:${layer}`);
    this.layers.push({ trackId, layer });
  }
  async requestKeyframe(trackId: string): Promise<void> {
    this.calls.push(`keyframe:${trackId}`);
    this.keyframes.push(trackId);
  }
  async handleOffer(offer: OfferPayload): Promise<void> {
    this.calls.push('offer');
    this.offers.push(offer);
  }
  async handleAnswer(answer: OfferPayload): Promise<void> {
    this.calls.push('answer');
    this.answers.push(answer);
  }
  async addIceCandidate(candidate: IcePayload): Promise<void> {
    this.calls.push('ice');
    this.candidates.push(candidate);
  }
  async leave(): Promise<void> {
    this.calls.push('leave');
    this.left = true;
  }
}

class FakeGateway implements SfuGateway {
  readonly sessions: FakeSession[] = [];
  readonly trackEvents: SfuTrackEvent[] = [];
  joins: Array<{ roomId: string; participantId: string; opts?: SfuJoinOptions }> = [];
  private trackListeners = new Set<(e: SfuTrackEvent) => void>();
  failNextPublishWith?: Error;

  async join(roomId: string, participantId: string, opts?: SfuJoinOptions): Promise<SfuSession> {
    this.joins.push({ roomId, participantId, opts });
    const session = new FakeSession(roomId, participantId);
    this.sessions.push(session);
    return session;
  }

  onTrack(cb: (event: SfuTrackEvent) => void): () => void {
    this.trackListeners.add(cb);
    return () => {
      this.trackListeners.delete(cb);
    };
  }

  async close(roomId?: string): Promise<void> {
    for (const s of this.sessions) {
      if (roomId === undefined || s.roomId === roomId) await s.leave();
    }
  }

  /** Test helper: fire a track event through the gateway. */
  emitTrack(event: SfuTrackEvent): void {
    this.trackEvents.push(event);
    for (const cb of [...this.trackListeners]) cb(event);
  }
}

function sfuEnvelope(
  over: Partial<{
    roomId: string;
    senderId: string;
    action: string;
    trackId: string;
    kind: string;
    senderIdTarget: string;
    layer: string;
  }> = {},
): Envelope {
  const {
    roomId = 'room-1',
    senderId = 'alice',
    action = 'publish',
    trackId = 't1',
    kind = 'video',
    senderIdTarget,
    layer,
  } = over;
  return createEnvelope('sfu', {
    roomId,
    senderId,
    sessionId: 'sess-1',
    seq: 1,
    // Deliberately loosely typed: some tests feed unknown actions to the
    // router, which must reject them (the router, not the helper, validates).
    payload: {
      action,
      ...(trackId !== undefined ? { trackId } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(senderIdTarget !== undefined ? { senderId: senderIdTarget } : {}),
      ...(layer !== undefined ? { layer } : {}),
    } as SfuPayload,
  });
}

function mediaEnvelope(
  type: 'offer' | 'answer' | 'ice',
  over: Partial<{ roomId: string; senderId: string; target: string }> = {},
): Envelope {
  const { roomId = 'room-1', senderId = 'alice', target = 'sfu' } = over;
  const payload =
    type === 'ice'
      ? {
          candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 5000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        }
      : { sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  return createEnvelope(type, {
    roomId,
    senderId,
    sessionId: 'sess-1',
    seq: 1,
    targetSenderId: target,
    payload,
  });
}

interface RouterHarness {
  router: SfuRouter;
  gateway: FakeGateway;
  errors: Array<{ code: SfuRouterErrorCode; roomId: string; senderId: string; message?: string }>;
}

function harness(members = new Set(['alice', 'bob']), sfuParticipantId = 'sfu'): RouterHarness {
  const gateway = new FakeGateway();
  const router = new SfuRouter({
    gateway,
    isParticipant: (roomId, participantId) => members.has(participantId) && roomId === 'room-1',
    sfuParticipantId,
  });
  const errors: Array<{
    code: SfuRouterErrorCode;
    roomId: string;
    senderId: string;
    message?: string;
  }> = [];
  router.on('error', (e) =>
    errors.push({ code: e.code, roomId: e.roomId, senderId: e.senderId, message: e.message }),
  );
  return { router, gateway, errors };
}

async function joined(
  roomId = 'room-1',
  participantId = 'alice',
): Promise<{ h: RouterHarness; session: FakeSession }> {
  const h = harness();
  const session = (await h.gateway.join(roomId, participantId)) as FakeSession;
  h.router.registerSession(session);
  return { h, session };
}

// ------------------------------------------------- router: sfu envelopes

test('routes publish to the session and emits published', async () => {
  const { h, session } = await joined();
  const events: string[] = [];
  h.router.on('published', (e) =>
    events.push(`${e.roomId}/${e.participantId}/${e.trackId}/${e.kind}`),
  );

  await h.router.handle(sfuEnvelope({ action: 'publish', trackId: 'cam', kind: 'video' }));

  assert.deepEqual(session.published, [
    { trackId: 'cam', kind: 'video', opts: { simulcast: false } },
  ]);
  assert.deepEqual(events, ['room-1/alice/cam/video']);
});

test('routes subscribe with a target sender to that participant only', async () => {
  const { h, session } = await joined();
  await h.router.handle(sfuEnvelope({ action: 'subscribe', senderIdTarget: 'bob' }));
  assert.deepEqual(session.subscribed, ['bob']);
});

test('bare subscribe fans out to every registered publisher except the requester', async () => {
  const h = harness(new Set(['alice', 'bob', 'carol']));
  const session = (await h.gateway.join('room-1', 'alice')) as FakeSession;
  h.router.registerSession(session);
  h.router.registerSession(await h.gateway.join('room-1', 'bob'));
  h.router.registerSession(await h.gateway.join('room-1', 'carol'));
  await h.router.handle(
    sfuEnvelope({ action: 'publish', senderId: 'bob', trackId: 'b1', kind: 'video' }),
  );
  await h.router.handle(
    sfuEnvelope({ action: 'publish', senderId: 'carol', trackId: 'c1', kind: 'audio' }),
  );
  await h.router.handle(sfuEnvelope({ action: 'subscribe' }));

  assert.deepEqual(session.subscribed.sort(), ['bob', 'carol']);
});

test('bare subscribe with no publishers errors with invalid-payload', async () => {
  const { h, session } = await joined();
  await h.router.handle(sfuEnvelope({ action: 'subscribe' }));
  assert.deepEqual(
    h.errors.map((e) => e.code),
    ['invalid-payload'],
  );
  assert.deepEqual(session.subscribed, []);
});

test('routes layer-change and keyframe-request', async () => {
  const { h, session } = await joined();
  await h.router.handle(sfuEnvelope({ action: 'layer-change', trackId: 'b1', layer: 'h' }));
  await h.router.handle(sfuEnvelope({ action: 'keyframe-request', trackId: 'b1' }));
  assert.deepEqual(session.layers, [{ trackId: 'b1', layer: 'h' }]);
  assert.deepEqual(session.keyframes, ['b1']);
});

test('leave closes the session, unregisters it, and emits left', async () => {
  const { h, session } = await joined();
  const left: string[] = [];
  h.router.on('left', (e) => left.push(`${e.roomId}/${e.participantId}`));

  await h.router.handle(sfuEnvelope({ action: 'leave' }));

  assert.equal(session.left, true);
  assert.equal(h.router.hasSession('room-1', 'alice'), false);
  assert.deepEqual(left, ['room-1/alice']);
  // A second leave now fails as not-joined.
  await h.router.handle(sfuEnvelope({ action: 'leave' }));
  assert.deepEqual(
    h.errors.map((e) => e.code),
    ['not-joined'],
  );
});

test("unpublishes a leaver's tracks so bare subscribe stops targeting them", async () => {
  const { h, session } = await joined();
  h.router.registerSession(await h.gateway.join('room-1', 'bob'));
  await h.router.handle(
    sfuEnvelope({ action: 'publish', senderId: 'bob', trackId: 'b1', kind: 'video' }),
  );
  await h.router.handle(sfuEnvelope({ action: 'leave', senderId: 'bob' }));
  await h.router.handle(sfuEnvelope({ action: 'subscribe' }));
  assert.deepEqual(session.subscribed, []);
  assert.equal(h.router.hasSession('room-1', 'bob'), false);
});

test('rejects a publish from a non-member (unknown room/participant)', async () => {
  const h = harness(new Set(['alice']));
  await h.router.handle(sfuEnvelope({ senderId: 'mallory' }));
  assert.deepEqual(
    h.errors.map(({ code, roomId, senderId }) => ({ code, roomId, senderId })),
    [{ code: 'not-a-participant', roomId: 'room-1', senderId: 'mallory' }],
  );
});

test('rejects an sfu envelope for an unknown room', async () => {
  const h = harness();
  await h.router.handle(sfuEnvelope({ roomId: 'room-404', senderId: 'alice' }));
  assert.deepEqual(
    h.errors.map(({ code, roomId, senderId }) => ({ code, roomId, senderId })),
    [{ code: 'not-a-participant', roomId: 'room-404', senderId: 'alice' }],
  );
});

test('rejects envelopes from joined participants with no session (not-joined)', async () => {
  const h = harness();
  await h.router.handle(sfuEnvelope({ action: 'publish' }));
  assert.deepEqual(
    h.errors.map((e) => e.code),
    ['not-joined'],
  );
});

test('rejects unknown sfu actions and malformed payloads', async () => {
  const { h, session } = await joined();
  await h.router.handle(sfuEnvelope({ action: 'teleport' }));
  await h.router.handle(
    createEnvelope('sfu', {
      roomId: 'room-1',
      senderId: 'alice',
      sessionId: 's',
      seq: 2,
      payload: {} as SfuPayload,
    }),
  );
  await h.router.handle(sfuEnvelope({ action: 'publish', trackId: '', kind: 'video' }));
  await h.router.handle(sfuEnvelope({ action: 'publish', trackId: 't1', kind: 'hologram' }));
  await h.router.handle(sfuEnvelope({ action: 'layer-change', trackId: 't1', layer: '' }));
  await h.router.handle(sfuEnvelope({ action: 'keyframe-request', trackId: '' }));

  assert.deepEqual(
    h.errors.map((e) => e.code),
    [
      'unknown-action',
      'unknown-action',
      'invalid-payload',
      'invalid-payload',
      'invalid-payload',
      'invalid-payload',
    ],
  );
  assert.equal(session.published.length, 0);
  assert.equal(session.keyframes.length, 0);
});

test('gateway failures surface as gateway-error events', async () => {
  const { h, session } = await joined();
  session.publishTrack = async () => {
    throw new Error('boom');
  };
  await h.router.handle(sfuEnvelope({ action: 'publish' }));
  assert.deepEqual(
    h.errors.map((e) => e.code),
    ['gateway-error'],
  );
  assert.match(h.errors[0]!.message ?? '', /boom/);
});

// ---------------------------------------------- router: offer/answer/ice to SFU

test('forwards offer/answer/ice envelopes addressed to the SFU', async () => {
  const { h, session } = await joined();
  await h.router.handle(mediaEnvelope('offer'));
  await h.router.handle(mediaEnvelope('answer'));
  await h.router.handle(mediaEnvelope('ice'));
  assert.deepEqual(session.calls, ['offer', 'answer', 'ice']);
  assert.equal(session.offers[0]!.sdp.length > 0, true);
  assert.deepEqual(session.candidates[0], {
    candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 5000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  });
});

test('ignores offer/answer/ice addressed to another participant (mesh traffic)', async () => {
  const { h, session } = await joined();
  await h.router.handle(mediaEnvelope('offer', { target: 'bob' }));
  await h.router.handle(mediaEnvelope('answer', { target: 'bob' }));
  await h.router.handle(mediaEnvelope('ice', { target: 'bob' }));
  assert.deepEqual(session.calls, []);
});

test('offer to the SFU without a joined session fails with not-joined', async () => {
  const h = harness();
  await h.router.handle(mediaEnvelope('offer'));
  assert.deepEqual(
    h.errors.map((e) => e.code),
    ['not-joined'],
  );
});

test('respects a custom sfuParticipantId', async () => {
  const { h } = await joined();
  h.router.unregisterSession('room-1', 'alice'); // rebuild with custom id
  const custom = new SfuRouter({
    gateway: h.gateway,
    isParticipant: () => true,
    sfuParticipantId: 'media-bot',
  });
  const s = new FakeSession('room-1', 'alice');
  custom.registerSession(s);
  const events: string[] = [];
  custom.on('error', (e) => events.push(e.code));

  await custom.handle(mediaEnvelope('offer', { target: 'sfu' })); // not addressed to media-bot
  await custom.handle(mediaEnvelope('offer', { target: 'media-bot' }));
  assert.deepEqual(s.calls, ['offer']);
  assert.deepEqual(events, []);
});

test('non-sfu envelope types are ignored', async () => {
  const { h, session } = await joined();
  await h.router.handle(
    createEnvelope('chat', {
      roomId: 'room-1',
      senderId: 'alice',
      sessionId: 's',
      seq: 1,
      payload: { text: 'hi' },
    }),
  );
  await h.router.handle(
    createEnvelope('reaction', {
      roomId: 'room-1',
      senderId: 'alice',
      sessionId: 's',
      seq: 2,
      payload: { emoji: '🎉' },
    }),
  );
  assert.deepEqual(session.calls, []);
});

// ---------------------------------------------------------- gateway contract

test('SfuGateway contract: join returns a session, onTrack unsubscribes, close tears down', async () => {
  const gateway = new FakeGateway();
  const seen: SfuTrackEvent[] = [];
  const off = gateway.onTrack((e) => seen.push(e));

  const session = await gateway.join('room-1', 'alice', { transportOpts: { ice: true } });
  assert.equal(session.roomId, 'room-1');
  assert.equal(session.participantId, 'alice');
  assert.deepEqual(gateway.joins[0]!.opts, { transportOpts: { ice: true } });

  const event: SfuTrackEvent = {
    roomId: 'room-1',
    participantId: 'alice',
    trackId: 'cam',
    kind: 'video',
    direction: 'send',
    publicationId: 'p1',
  };
  gateway.emitTrack(event);
  assert.deepEqual(seen, [event]);

  off();
  gateway.emitTrack(event);
  assert.deepEqual(seen, [event]); // unsubscribed

  await gateway.close('room-1');
  assert.equal(gateway.sessions[0]!.left, true);
});

test('SfuRouter wires a real gateway: publish + subscribe flow', async () => {
  const gateway = new FakeGateway();
  const router = new SfuRouter({ gateway, isParticipant: () => true });
  const alice = await gateway.join('room-1', 'alice');
  const bob = await gateway.join('room-1', 'bob');
  router.registerSession(alice);
  router.registerSession(bob);

  await router.handle(
    sfuEnvelope({ action: 'publish', senderId: 'alice', trackId: 'cam', kind: 'video' }),
  );
  await router.handle(
    sfuEnvelope({ action: 'subscribe', senderId: 'bob', senderIdTarget: 'alice' }),
  );

  const bobSession = bob as FakeSession;
  assert.deepEqual(bobSession.subscribed, ['alice']);
});
