import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSdpOrigin, SdpIdempotencyGuard } from '../src/sdp.ts';

const SDP_A = 'v=0\r\no=- sess-1 5 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const SDP_A_NEWER = 'v=0\r\no=- sess-1 6 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const SDP_B = 'v=0\r\no=- sess-2 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

test('parseSdpOrigin: extracts session id and version', () => {
  const origin = parseSdpOrigin(SDP_A);
  assert.deepEqual(origin, {
    username: '-',
    sessionId: 'sess-1',
    sessionVersion: 5,
    netType: 'IN',
    addrType: 'IP4',
    unicastAddress: '127.0.0.1',
  });
});

test('parseSdpOrigin: returns null for garbage', () => {
  assert.equal(parseSdpOrigin('not an sdp'), null);
  assert.equal(parseSdpOrigin(''), null);
});

test('SdpIdempotencyGuard: ignores retransmissions, accepts newer versions', () => {
  const guard = new SdpIdempotencyGuard();
  assert.equal(guard.isDuplicate('offer', SDP_A), false);
  guard.record('offer', SDP_A);

  assert.equal(guard.isDuplicate('offer', SDP_A), true); // same version
  assert.equal(guard.isDuplicate('answer', SDP_A), true); // same session/version, any type
  assert.equal(guard.isDuplicate('offer', SDP_A_NEWER), false); // renegotiation
  guard.record('offer', SDP_A_NEWER);
  assert.equal(guard.isDuplicate('offer', SDP_A), true); // older after newer
});

test('SdpIdempotencyGuard: different session id is never a duplicate', () => {
  const guard = new SdpIdempotencyGuard();
  guard.record('offer', SDP_A);
  assert.equal(guard.isDuplicate('offer', SDP_B), false);
});

test('SdpIdempotencyGuard: unparseable SDP never blocks', () => {
  const guard = new SdpIdempotencyGuard();
  guard.record('offer', SDP_A);
  assert.equal(guard.isDuplicate('offer', 'garbage'), false);
});
