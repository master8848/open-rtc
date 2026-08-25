/**
 * MediasoupAdapter integration test — real mediasoup Worker + Router.
 *
 * Env-gated: skipped unless `VIDCALL_MEDIASOUP_INTEGRATION=1` (the mediasoup
 * worker is a native binary; CI and default `npm test` skip gracefully).
 *
 * Run:
 *   cd packages/sfu-gateway && npm run test:integration
 * or from the repo root:
 *   VIDCALL_MEDIASOUP_INTEGRATION=1 node --conditions=development \
 *     --test packages/sfu-gateway/test/integration.mediasoup.test.ts
 *
 * Covers the full wiring with no browser client: Worker -> Router -> adapter
 * -> join -> publishTrack + handleOffer (real produce) -> subscribe (real
 * consume) -> layer change -> keyframe -> leave. Requires build tools or the
 * prebuilt worker binary (mediasoup 3.23.1 postinstall handles this).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OfferPayload } from '@mbsks/protocol';
import { MediasoupAdapter } from '../src/mediasoup-adapter.ts';

const ENABLED = process.env.VIDCALL_MEDIASOUP_INTEGRATION === '1';
const it = ENABLED ? test : test.skip;

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
  ].join('\r\n') + '\r\n';

it('full wiring on a real mediasoup worker', async () => {
  const mediasoup = await import('mediasoup');
  const worker = await mediasoup.createWorker();
  try {
    const router = await worker.createRouter({
      mediaCodecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
      ],
    });
    const answers: Array<{ roomId: string; participantId: string; sdp: string }> = [];
    const adapter = new MediasoupAdapter({
      router,
      onAnswer: (roomId, participantId, sdp) => answers.push({ roomId, participantId, sdp }),
    });
    const trackEvents: string[] = [];
    adapter.onTrack((e) => trackEvents.push(`${e.direction}:${e.participantId}:${e.trackId}`));

    // join + publish (real WebRtcTransport + Producer)
    const alice = await adapter.join('room-1', 'alice', {
      transportOpts: { listenIps: ['127.0.0.1'] },
    });
    await alice.publishTrack('cam', 'video');
    await alice.handleOffer({ sdp: OFFER_VIDEO } as OfferPayload);
    assert.deepEqual(trackEvents, ['send:alice:cam']);
    assert.equal(answers.length, 1);
    assert.match(answers[0]!.sdp, /a=ice-ufrag:/);
    assert.match(answers[0]!.sdp, /a=fingerprint:/); // worker default cert is sha-1

    // subscribe (real Consumer on a second transport)
    const bob = await adapter.join('room-1', 'bob', {
      transportOpts: { listenIps: ['127.0.0.1'] },
    });
    await bob.subscribe('alice');
    assert.deepEqual(trackEvents, ['send:alice:cam', 'receive:bob:cam']);

    // control plane against real objects (keyframe is receiver-driven)
    await bob.setPreferredLayers('cam', 'h');
    await bob.requestKeyframe('cam');
    await alice.addIceCandidate({
      candidate: '1 1 udp 2130706431 127.0.0.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });

    // teardown
    await alice.leave();
    await bob.leave();
    assert.equal(router.closed, false); // router outlives sessions
    await adapter.close();
  } finally {
    worker.close();
  }
});
