/**
 * L0 typed-payload conformance — mirrors the Dart "Typed payload decode
 * (canonical fixtures)" group and the Kotlin typed decode tests
 * (`join envelope decodes the full device profile...`, `offer envelope decodes
 * and round-trips an SDP`, `ice envelope decodes candidate/sdpMid/...`),
 * asserting fixture payloads against the exported `MessagePayloadMap` types.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFixture } from './helpers.ts';
import type {
  ChatPayload,
  ErrorPayload,
  IcePayload,
  JoinPayload,
  LeavePayload,
  OfferPayload,
  PresencePayload,
  QualityWarningPayload,
  ReactionPayload,
  ScreenSharePayload,
  SfuPayload,
} from '../types.ts';

// --- join -------------------------------------------------------------------

test('join: full device profile and capabilities', () => {
  const envelope = decodeFixture('join');
  assert.equal(envelope.type, 'join');
  const join = envelope.payload as JoinPayload;
  assert.equal(join.displayName, 'Ada Lovelace');
  assert.deepEqual(join.metadata, { tier: 'pro', locale: 'en' });
  assert.equal(join.deviceProfile?.hardwareConcurrency, 8);
  assert.equal(join.deviceProfile?.deviceMemory, 8.0);
  assert.equal(join.deviceProfile?.mobile, false);
  assert.equal(join.deviceProfile?.screenWidth, 1920);
  assert.equal(join.deviceProfile?.screenHeight, 1080);
  assert.equal(join.deviceProfile?.platform, 'browser');
  assert.deepEqual(join.capabilities?.codecs, ['VP8', 'H264']);
  assert.equal(join.capabilities?.simulcast, true);
  assert.equal(join.capabilities?.svc, false);
});

test('join-targeted: same payload shape plus unicast target', () => {
  const envelope = decodeFixture('join-targeted');
  assert.equal(envelope.type, 'join');
  assert.equal(envelope.targetSenderId, 'user-ada');
  const join = envelope.payload as JoinPayload;
  assert.equal(join.displayName, 'Bob Builder');
  assert.deepEqual(join.metadata, { tier: 'free', locale: 'de' });
  assert.equal(join.deviceProfile?.hardwareConcurrency, 4);
  assert.equal(join.deviceProfile?.deviceMemory, 4.0);
  assert.equal(join.deviceProfile?.mobile, true);
  assert.equal(join.capabilities?.simulcast, false);
  assert.deepEqual(join.capabilities?.codecs, ['H264']);
});

// --- offer / answer ---------------------------------------------------------

test('offer: typed payload decodes opaque sdp', () => {
  const offer = decodeFixture('offer').payload as OfferPayload;
  assert.ok(offer.sdp.startsWith('v=0'));
  assert.ok(offer.sdp.includes('m=audio'));
  assert.ok(offer.sdp.includes('a=rtpmap:96 VP8/90000'));
  assert.equal(typeof offer.sdp, 'string');
  assert.equal(offer.label, 'main');
});

test('answer uses the offer payload shape', () => {
  const answer = decodeFixture('answer').payload as OfferPayload;
  assert.equal(answer.label, 'main');
  assert.ok(answer.sdp.startsWith('v=0'));
  assert.ok(answer.sdp.includes('a=recvonly'));
});

test('offer-targeted / answer-targeted carry the SDP payloads unicast', () => {
  for (const name of ['offer-targeted', 'answer-targeted'] as const) {
    const envelope = decodeFixture(name);
    assert.equal(envelope.targetSenderId, 'user-ada');
    const sdp = envelope.payload as OfferPayload;
    assert.ok(sdp.sdp.startsWith('v=0'), `${name}: sdp`);
    assert.equal(sdp.label, 'main', `${name}: label`);
  }
});

// --- ice --------------------------------------------------------------------

test('ice: candidate, sdpMid and sdpMLineIndex with nullable wire types', () => {
  const ice = decodeFixture('ice').payload as IcePayload;
  assert.ok(ice.candidate.startsWith('candidate:842163049'));
  assert.equal(typeof ice.candidate, 'string');
  assert.equal(ice.sdpMid, '0');
  assert.equal(ice.sdpMLineIndex, 0);
  // schema.json: sdpMid is string|null, sdpMLineIndex is integer|null
  assert.ok(ice.sdpMid === null || typeof ice.sdpMid === 'string', `${ice.sdpMid}`);
  assert.ok(
    ice.sdpMLineIndex === null || Number.isInteger(ice.sdpMLineIndex),
    `${ice.sdpMLineIndex}`,
  );
});

test('ice-targeted: unicast candidate', () => {
  const envelope = decodeFixture('ice-targeted');
  assert.equal(envelope.targetSenderId, 'user-ada');
  const ice = envelope.payload as IcePayload;
  assert.ok(ice.candidate.startsWith('candidate:842163049'));
  assert.equal(ice.sdpMid, '0');
  assert.equal(ice.sdpMLineIndex, 0);
});

// --- chat / reaction / presence / leave --------------------------------------

test('chat: broadcast text without replyTo', () => {
  const chat = decodeFixture('chat').payload as ChatPayload;
  assert.equal(chat.text, 'hello room');
  assert.equal(chat.replyTo, undefined);
});

test('chat-targeted: unicast text with replyTo', () => {
  const envelope = decodeFixture('chat-targeted');
  assert.equal(envelope.targetSenderId, 'user-ada');
  const chat = envelope.payload as ChatPayload;
  assert.equal(chat.text, 'psst ada');
  assert.equal(chat.replyTo?.senderId, 'user-ada');
  assert.equal(chat.replyTo?.seq, 0);
});

test('chat text respects the schema maxLength of 4000', () => {
  for (const name of ['chat', 'chat-targeted'] as const) {
    const chat = decodeFixture(name).payload as ChatPayload;
    assert.ok(chat.text.length <= 4000, `${name}: text length ${chat.text.length} > 4000`);
  }
});

test('reaction: broadcast emoji without payload-level target', () => {
  const reaction = decodeFixture('reaction').payload as ReactionPayload;
  assert.equal(reaction.emoji, '🎉');
  assert.equal(reaction.targetSenderId, undefined);
});

test('reaction-targeted: emoji addressed at a peer in the payload too', () => {
  const envelope = decodeFixture('reaction-targeted');
  assert.equal(envelope.targetSenderId, 'user-ada');
  const reaction = envelope.payload as ReactionPayload;
  assert.equal(reaction.emoji, '👍');
  assert.equal(reaction.targetSenderId, 'user-ada');
});

test('presence: state and metadata', () => {
  const presence = decodeFixture('presence').payload as PresencePayload;
  assert.equal(presence.state, 'online');
  assert.deepEqual(presence.metadata, { muted: false });
});

test('presence-targeted: busy state unicast to ada', () => {
  const envelope = decodeFixture('presence-targeted');
  assert.equal(envelope.targetSenderId, 'user-ada');
  const presence = envelope.payload as PresencePayload;
  assert.equal(presence.state, 'busy');
  assert.deepEqual(presence.metadata, { muted: true });
});

test('leave: reasons on both broadcast and targeted variants', () => {
  const leave = decodeFixture('leave').payload as LeavePayload;
  assert.equal(leave.reason, 'bye');
  const targeted = decodeFixture('leave-targeted').payload as LeavePayload;
  assert.equal(targeted.reason, 'call-ended');
});

// --- media control payloads --------------------------------------------------

test('screen-share: start with label', () => {
  const share = decodeFixture('screen-share').payload as ScreenSharePayload;
  assert.equal(share.action, 'start');
  assert.equal(share.label, 'screen');
});

test('quality-warning: tier switch', () => {
  const warning = decodeFixture('quality-warning').payload as QualityWarningPayload;
  assert.equal(warning.from, '720p@30');
  assert.equal(warning.to, '480p@30');
  assert.equal(warning.reason, 'network');
  assert.equal(warning.direction, 'receive');
});

test('sfu: publish video track', () => {
  const sfu = decodeFixture('sfu').payload as SfuPayload;
  assert.equal(sfu.action, 'publish');
  assert.equal(sfu.trackId, 'track-1');
  assert.equal(sfu.kind, 'video');
});

test('error: protocol-version code and message', () => {
  const error = decodeFixture('error').payload as ErrorPayload;
  assert.equal(error.code, 'protocol-version');
  assert.equal(error.message, 'unsupported protocol version 2');
  assert.equal(typeof error.code, 'string');
  assert.equal(typeof error.message, 'string');
});
