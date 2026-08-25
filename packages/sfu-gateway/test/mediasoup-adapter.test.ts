/**
 * MediasoupAdapter wiring smoke tests — fake Router/Transport/Producer/
 * Consumer, no mediasoup worker needed. Also unit-tests the minimal SDP
 * helpers. Real-worker coverage lives in integration.mediasoup.test.ts
 * (env-gated by VIDCALL_MEDIASOUP_INTEGRATION=1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { types as MediasoupTypes } from 'mediasoup';
import type { IcePayload, OfferPayload } from '@mbsks/openrtc-protocol';
import { MediasoupAdapter, type MediasoupAdapterOptions } from '../src/mediasoup-adapter.ts';
import {
  buildSdpAnswer,
  dtlsParametersFromSdp,
  minimalRtpParameters,
  parseSdp,
} from '../src/sdp.ts';
import type { SfuTrackEvent } from '../src/sfu-gateway.ts';

// ------------------------------------------------------------------ fakes

class FakeProducer {
  readonly id: string;
  readonly kind: 'audio' | 'video';
  readonly appData: Record<string, unknown>;
  keyframeRequests = 0;
  constructor(id: string, kind: 'audio' | 'video', appData: Record<string, unknown>) {
    this.id = id;
    this.kind = kind;
    this.appData = appData;
  }
  async requestKeyFrame(): Promise<void> {
    this.keyframeRequests += 1;
  }
  close(): void {}
}

class FakeConsumer {
  readonly id: string;
  readonly kind: 'audio' | 'video';
  readonly appData: Record<string, unknown>;
  preferredLayers: Array<{ spatialLayer: number; temporalLayer: number }> = [];
  keyframeRequests = 0;
  constructor(id: string, kind: 'audio' | 'video', appData: Record<string, unknown>) {
    this.id = id;
    this.kind = kind;
    this.appData = appData;
  }
  async setPreferredLayers(layers: { spatialLayer: number; temporalLayer: number }): Promise<void> {
    this.preferredLayers.push(layers);
  }
  async requestKeyFrame(): Promise<void> {
    this.keyframeRequests += 1;
  }
  close(): void {}
}

class FakeTransport {
  readonly id: string;
  closed = false;
  readonly appData: Record<string, unknown>;
  readonly iceParameters = { usernameFragment: 'srv-ufrag', password: 'srv-password' };
  readonly dtlsParameters = {
    fingerprints: [
      {
        algorithm: 'sha-256',
        value:
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      },
    ],
  };
  readonly iceCandidates = [
    {
      foundation: '1',
      priority: 2130706431,
      protocol: 'udp',
      address: '10.0.0.2',
      port: 4444,
      type: 'host',
    },
  ];
  produced: Array<{ kind: string; rtpParameters: unknown; appData: Record<string, unknown> }> = [];
  consumed: Array<{
    producerId: string;
    rtpCapabilities: unknown;
    appData: Record<string, unknown>;
  }> = [];
  /** The FakeConsumer instances returned by `consume` (the call args are in `consumed`). */
  consumers: FakeConsumer[] = [];
  connects: Array<{ dtlsParameters: unknown }> = [];
  iceCandidatesAdded: IcePayload[] = [];

  constructor(id: string, appData: Record<string, unknown>) {
    this.id = id;
    this.appData = appData;
  }

  async createWebRtcTransport(_opts: unknown): Promise<FakeTransport> {
    return this;
  }
  async produce(args: {
    kind: 'audio' | 'video';
    rtpParameters: unknown;
    appData: Record<string, unknown>;
  }): Promise<FakeProducer> {
    this.produced.push(args);
    return new FakeProducer(`producer-${this.produced.length}`, args.kind, args.appData);
  }
  async consume(args: {
    producerId: string;
    rtpCapabilities: unknown;
    appData: Record<string, unknown>;
  }): Promise<FakeConsumer> {
    this.consumed.push(args);
    const consumer = new FakeConsumer(
      `consumer-${this.consumers.length + 1}`,
      'video',
      args.appData,
    );
    this.consumers.push(consumer);
    return consumer;
  }
  async connect(args: { dtlsParameters: unknown }): Promise<void> {
    this.connects.push(args);
  }
  async addIceCandidate(candidate: IcePayload): Promise<void> {
    this.iceCandidatesAdded.push(candidate);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeRouter {
  readonly transports: FakeTransport[] = [];
  readonly rtpCapabilities = { codecs: [{ mimeType: 'video/VP8' }] };
  lastTransportOptions: Record<string, unknown> | null = null;
  constructor() {}
  async createWebRtcTransport(opts: { appData: Record<string, unknown> }): Promise<FakeTransport> {
    this.lastTransportOptions = opts;
    const t = new FakeTransport(`transport-${this.transports.length + 1}`, opts.appData);
    this.transports.push(t);
    return t;
  }
}

const OFFER_VIDEO =
  [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    'a=setup:actpass',
    'a=ice-ufrag:cli-ufrag',
    'a=ice-pwd:cli-password',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:97 rtx/90000',
    'a=rtx:97 apt=96',
    'a=candidate:1 1 udp 2130706431 192.168.1.5 5000 typ host',
  ].join('\r\n') + '\r\n';

const OFFER_AUDIO =
  [
    'v=0',
    'o=- 2 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    'a=setup:actpass',
    'a=ice-ufrag:cli-ufrag',
    'a=ice-pwd:cli-password',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=rtpmap:111 opus/48000/2',
  ].join('\r\n') + '\r\n';

interface Harness {
  router: FakeRouter;
  adapter: MediasoupAdapter;
  trackEvents: SfuTrackEvent[];
  answers: Array<{ roomId: string; participantId: string; sdp: string }>;
}

function harness(extraOptions: Partial<MediasoupAdapterOptions> = {}): Harness {
  const router = new FakeRouter();
  const trackEvents: SfuTrackEvent[] = [];
  const answers: Array<{ roomId: string; participantId: string; sdp: string }> = [];
  const adapter = new MediasoupAdapter({
    router: router as unknown as MediasoupTypes.Router,
    onAnswer: (roomId, participantId, sdp) => answers.push({ roomId, participantId, sdp }),
    ...extraOptions,
  });
  adapter.onTrack((e) => trackEvents.push(e));
  return { router, adapter, trackEvents, answers };
}

// ------------------------------------------------------------------ sdp.ts

test('parseSdp extracts dtls/ice/candidates/media', () => {
  const parsed = parseSdp(OFFER_VIDEO);
  assert.equal(parsed.dtls.setup, 'actpass');
  assert.equal(parsed.dtls.fingerprints.length, 1);
  assert.equal(parsed.dtls.fingerprints[0]!.algorithm, 'sha-256');
  assert.equal(parsed.ice.ufrag, 'cli-ufrag');
  assert.equal(parsed.ice.pwd, 'cli-password');
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0]!.kind, 'video');
  assert.deepEqual(parsed.media[0]!.codec, {
    payloadType: 96,
    codec: 'VP8',
    clockRate: 90000,
    rtxPayloadType: 97,
  });
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0]!.sdpMid, '0');
});

test('dtlsParametersFromSdp maps actpass to client role', () => {
  assert.deepEqual(dtlsParametersFromSdp(OFFER_VIDEO), {
    role: 'client',
    fingerprints: [
      {
        algorithm: 'sha-256',
        value:
          '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
      },
    ],
  });
  assert.equal(dtlsParametersFromSdp('v=0\r\ns=-\r\nt=0 0\r\n'), null);
});

test('minimalRtpParameters maps kinds and channels', () => {
  const video = minimalRtpParameters(OFFER_VIDEO, 'video');
  assert.deepEqual(video, {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
    encodings: [{ ssrc: 1000001 }], // placeholder SSRC (reference quality)
  });
  const audio = minimalRtpParameters(OFFER_AUDIO, 'audio');
  assert.deepEqual(audio, {
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
    encodings: [{ ssrc: 1000002 }],
  });
  assert.equal(minimalRtpParameters(OFFER_VIDEO, 'audio'), null); // no audio m-line
});

test('buildSdpAnswer round-trips through parseSdp', () => {
  const answer = buildSdpAnswer({
    iceUfrag: 'srv-ufrag',
    icePwd: 'srv-pwd',
    fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }],
    setup: 'passive',
    candidates: [
      {
        foundation: '1',
        priority: 2130706431,
        protocol: 'udp',
        address: '10.0.0.2',
        port: 4444,
        type: 'host',
      },
    ],
    media: [{ mid: '0', kind: 'video' }],
  });
  const parsed = parseSdp(answer);
  assert.equal(parsed.ice.ufrag, 'srv-ufrag');
  assert.equal(parsed.ice.pwd, 'srv-pwd');
  assert.equal(parsed.dtls.setup, 'passive');
  assert.equal(parsed.dtls.fingerprints[0]!.value, 'AA:BB');
  assert.equal(parsed.media[0]!.kind, 'video');
  assert.equal(parsed.candidates.length, 1);
});

// -------------------------------------------------------------- adapter map

test('join creates a WebRtcTransport with merged options', async () => {
  const { router, adapter } = harness({
    defaultTransportOptions: { enableUdp: true, enableTcp: true, listenIps: ['0.0.0.0'] },
  });
  const session = await adapter.join('room-1', 'alice', {
    transportOpts: { ice: false, sctp: true, listenIps: ['127.0.0.1'] },
  });
  assert.equal(session.roomId, 'room-1');
  assert.equal(session.participantId, 'alice');
  assert.equal(router.transports.length, 1);
  // Generic keys map onto mediasoup options; unknown keys forward verbatim.
  assert.deepEqual(router.lastTransportOptions, {
    enableUdp: false,
    enableTcp: false,
    enableSctp: true,
    listenIps: ['127.0.0.1'],
    appData: { roomId: 'room-1', participantId: 'alice' },
  });
});

test('join twice for the same participant throws', async () => {
  const { adapter } = harness();
  await adapter.join('room-1', 'alice');
  await assert.rejects(() => adapter.join('room-1', 'alice'), /already joined/);
});

test('publishTrack + handleOffer connects, produces, emits track, answers', async () => {
  const { router, adapter, trackEvents, answers } = harness();
  const alice = await adapter.join('room-1', 'alice');
  await alice.publishTrack('cam', 'video');
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);

  const transport = router.transports[0]!;
  assert.equal(transport.connects.length, 1);
  assert.equal((transport.connects[0]!.dtlsParameters as { role: string }).role, 'client');
  assert.equal(transport.produced.length, 1);
  assert.equal(transport.produced[0]!.kind, 'video');
  assert.deepEqual(
    (transport.produced[0]!.rtpParameters as { codecs: Array<{ mimeType: string }> }).codecs[0],
    {
      mimeType: 'video/VP8',
      payloadType: 96,
      clockRate: 90000,
    },
  );
  assert.deepEqual(trackEvents, [
    {
      roomId: 'room-1',
      participantId: 'alice',
      trackId: 'cam',
      kind: 'video',
      direction: 'send',
      publicationId: 'producer-1',
    },
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.roomId, 'room-1');
  assert.equal(answers[0]!.participantId, 'alice');
  assert.match(answers[0]!.sdp, /a=ice-ufrag:srv-ufrag/);
  assert.match(answers[0]!.sdp, /a=fingerprint:sha-256 AA:BB:CC/);
});

test('handleOffer without pending publications still connects and answers', async () => {
  const { router, adapter, answers } = harness();
  const alice = await adapter.join('room-1', 'alice');
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);
  assert.equal(router.transports[0]!.connects.length, 1);
  assert.equal(router.transports[0]!.produced.length, 0);
  assert.equal(answers.length, 1);
});

test('offer without a DTLS fingerprint fails cleanly', async () => {
  const { router, adapter, trackEvents } = harness();
  const alice = await adapter.join('room-1', 'alice');
  await assert.rejects(
    () => alice.handleOffer({ sdp: 'v=0\r\ns=-\r\nt=0 0\r\n' } as OfferPayload),
    /no DTLS fingerprint/,
  );
  assert.equal(router.transports[0]!.connects.length, 0);
  assert.equal(trackEvents.length, 0);
});

test('screen kind maps to a video producer', async () => {
  const { router, adapter, trackEvents } = harness();
  const alice = await adapter.join('room-1', 'alice');
  await alice.publishTrack('shared', 'screen');
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);
  assert.equal(router.transports[0]!.produced[0]!.kind, 'video');
  assert.equal(trackEvents[0]!.kind, 'screen');
});

test('publishTrack forwards keyFrameRequestDelayMs to produce (video only)', async () => {
  const { router, adapter } = harness();
  const alice = await adapter.join('room-1', 'alice');
  await alice.publishTrack('cam', 'video', { keyFrameRequestDelayMs: 2500 });
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);
  const producedArgs = router.transports[0]!.produced[0] as unknown as {
    keyFrameRequestDelay?: number;
  };
  assert.equal(producedArgs.keyFrameRequestDelay, 2500);

  // Audio producers do not get the (video-only) delay hint.
  const bob = await adapter.join('room-1', 'bob');
  await bob.publishTrack('mic', 'audio', { keyFrameRequestDelayMs: 2500 });
  await bob.handleOffer({ sdp: OFFER_AUDIO } as OfferPayload);
  const audioArgs = router.transports[1]!.produced[0] as unknown as {
    keyFrameRequestDelay?: number;
  };
  assert.equal(audioArgs.keyFrameRequestDelay, undefined);
});

test("subscribe consumes the target's producers and emits receive tracks", async () => {
  const { router, adapter, trackEvents } = harness();
  const alice = await adapter.join('room-1', 'alice');
  const bob = await adapter.join('room-1', 'bob');
  await alice.publishTrack('cam', 'video');
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);

  await bob.subscribe('alice');
  const bobTransport = router.transports[1]!;
  assert.equal(bobTransport.consumed.length, 1);
  assert.equal(bobTransport.consumed[0]!.producerId, 'producer-1');
  assert.deepEqual(
    trackEvents.map((e) => e.direction),
    ['send', 'receive'],
  );
  assert.equal(trackEvents[1]!.participantId, 'bob');
  assert.equal(trackEvents[1]!.publicationId, 'consumer-1');
});

test('setPreferredLayers maps l/m/h to spatial layers', async () => {
  const { router, adapter } = harness();
  const alice = await adapter.join('room-1', 'alice');
  const bob = await adapter.join('room-1', 'bob');
  await alice.publishTrack('cam', 'video');
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);
  await bob.subscribe('alice');

  await bob.setPreferredLayers('cam', 'h');
  await bob.setPreferredLayers('cam', 'm');
  await bob.setPreferredLayers('cam', 'l');
  const fakeConsumer = router.transports[1]!.consumers[0]!;
  assert.deepEqual(fakeConsumer.preferredLayers, [
    { spatialLayer: 2, temporalLayer: -1 },
    { spatialLayer: 1, temporalLayer: -1 },
    { spatialLayer: 0, temporalLayer: -1 },
  ]);
});

test('setPreferredLayers on an unknown track throws', async () => {
  const { adapter } = harness();
  const bob = await adapter.join('room-1', 'bob');
  await assert.rejects(() => bob.setPreferredLayers('ghost', 'h'), /no consumer for track ghost/);
});

test('requestKeyframe is receiver-driven: consumer.requestKeyFrame()', async () => {
  const { router, adapter } = harness();
  const alice = await adapter.join('room-1', 'alice');
  const bob = await adapter.join('room-1', 'bob');
  await alice.publishTrack('cam', 'video');
  await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);
  await bob.subscribe('alice');
  await bob.requestKeyframe('cam');
  const fakeConsumer = router.transports[1]!.consumers[0]!;
  assert.equal(fakeConsumer.keyframeRequests, 1);
  await assert.rejects(() => bob.requestKeyframe('ghost'), /no consumer for track ghost/);
});

test('addIceCandidate is a no-op on mediasoup >= 3.23 (kept for the contract)', async () => {
  const { router, adapter } = harness();
  const alice = await adapter.join('room-1', 'alice');
  const candidate: IcePayload = {
    candidate: '1 1 udp 2130706431 192.168.1.5 5000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
  await alice.addIceCandidate(candidate); // must not throw
  assert.equal(router.transports[0]!.iceCandidatesAdded.length, 0); // worker consumes none
});

test('leave closes the transport and removes the session; adapter.close cleans up', async () => {
  const { router, adapter } = harness();
  const alice = await adapter.join('room-1', 'alice');
  await adapter.join('room-2', 'bob');
  await alice.leave();
  assert.equal(router.transports[0]!.closed, true);
  await alice.leave(); // idempotent
  await adapter.close('room-2');
  assert.equal(router.transports[1]!.closed, true);
  // All closed after scoped leaves; joining again works.
  const carol = await adapter.join('room-1', 'carol');
  assert.equal(carol.roomId, 'room-1');
});
