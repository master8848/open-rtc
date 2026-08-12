import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPeerPair, resetFakeRTC } from '../../test-utils/src/index.ts';
import { waitFor } from '../../test-utils/src/fixtures.ts';
import { DataChannelBus } from '../src/data-channel-bus.ts';

beforeEach(() => resetFakeRTC());

test('DataChannelBus: channels open on both ends of a wired pair', async () => {
  const { a, b } = createPeerPair();
  const busA = new DataChannelBus(a as unknown as RTCPeerConnection, { name: 'vidcall' });
  const busB = new DataChannelBus(b as unknown as RTCPeerConnection, { name: 'vidcall' });
  await Promise.all([busA.open(1000), busB.open(1000)]);
  assert.equal(busA.isOpen, true);
  assert.equal(busB.isOpen, true);
});

test('DataChannelBus: typed reaction/chat/control round-trip', async () => {
  const { a, b } = createPeerPair();
  const busA = new DataChannelBus(a as unknown as RTCPeerConnection, { name: 'vidcall' });
  const busB = new DataChannelBus(b as unknown as RTCPeerConnection, { name: 'vidcall' });
  await Promise.all([busA.open(1000), busB.open(1000)]);

  const reactions: string[] = [];
  const chats: string[] = [];
  const controls: string[] = [];
  busB.on('reaction', (p) => reactions.push(p.emoji));
  busB.on('chat', (p) => chats.push(p.text));
  busB.on('control', (p) => controls.push(p.action));

  busA.sendReaction('👍');
  busA.sendChat('hello');
  busA.sendControl({ action: 'keyframe-request', trackId: 't1' });
  await waitFor(() => reactions.length === 1 && chats.length === 1 && controls.length === 1);
  assert.deepEqual(reactions, ['👍']);
  assert.deepEqual(chats, ['hello']);
  assert.deepEqual(controls, ['keyframe-request']);
});

test('DataChannelBus: send before open throws', async () => {
  const { a } = createPeerPair();
  const bus = new DataChannelBus(a as unknown as RTCPeerConnection, { name: 'vidcall' });
  assert.throws(() => bus.sendChat('too early'), /not open/);
});

test('DataChannelBus: non-JSON and unknown-version messages are ignored', async () => {
  const { a, b } = createPeerPair();
  const busA = new DataChannelBus(a as unknown as RTCPeerConnection, { name: 'vidcall' });
  const busB = new DataChannelBus(b as unknown as RTCPeerConnection, { name: 'vidcall' });
  await Promise.all([busA.open(1000), busB.open(1000)]);
  const chats: string[] = [];
  busB.on('chat', (p) => chats.push(p.text));
  // Bypass the typed API: poke the raw channel.
  const channelA = (busA as unknown as { localChannel: { send: (d: string) => void } })
    .localChannel;
  channelA.send('not json');
  channelA.send(JSON.stringify({ v: 99, t: 'chat', d: { text: 'x' } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(chats, []);
});

test('DataChannelBus: close emits close and releases listeners', async () => {
  const { a, b } = createPeerPair();
  const busA = new DataChannelBus(a as unknown as RTCPeerConnection, { name: 'vidcall' });
  const busB = new DataChannelBus(b as unknown as RTCPeerConnection, { name: 'vidcall' });
  await Promise.all([busA.open(1000), busB.open(1000)]);
  let closed = false;
  busB.on('close', () => (closed = true));
  busA.close();
  await waitFor(() => closed);
  assert.equal(busA.readyState, 'closed');
});
