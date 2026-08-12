/**
 * SHARED adapter test suite.
 *
 * Every backend adapter package (supabase, convex, postgres, firebase,
 * appwrite, sqlite) runs this exact matrix against its own adapter — both in
 * unit tests (in-memory SDK mocks) and in env-var-gated integration tests.
 * It mirrors the adapter test matrix from docs/research/backend-adapters.md
 * (join/leave · SDP offer/answer round-trip ordering · ICE trickle burst ·
 * presence join/leave · reaction fan-out · payload-over-limit chunking ·
 * 2 concurrent rooms), adapted to the `SignalingTransport` contract from
 * packages/core (room-bound, `Envelope` payloads).
 *
 * Usage:
 *   import { runAdapterTestSuite, type AdapterHarness } from '@vidcall/transport/shared-tests';
 *   runAdapterTestSuite({
 *     name: 'supabase',
 *     createPeer: async (peerId) => new SupabaseBackend({ client, sessionId: 's-' + peerId }),
 *     destroyPeer: async (peer) => peer.dispose(),
 *     supportsLargePayload: true,
 *   });
 */
import { describe, it, expect } from 'vitest';
import { createEnvelope, type Envelope, type OfferPayload } from '@vidcall/protocol';
import type { ParticipantPresence, SignalingTransport } from './types.js';

export interface AdapterHarness {
  /** adapter name (describe title). */
  name: string;
  /**
   * Create a logical peer. Each call returns a distinct transport instance
   * (in-process backends may share infrastructure but must behave like
   * separate clients).
   */
  createPeer(peerId: string): Promise<SignalingTransport>;
  /** Destroy a peer and its resources. */
  destroyPeer(peer: SignalingTransport): Promise<void>;
  /**
   * True when payloads above the backend's frame cap are chunked and
   * reassembled transparently (postgres 7 KB chunker).
   */
  supportsLargePayload?: boolean;
  /** prefix for room names to avoid cross-run collisions. Default 'shared'. */
  roomPrefix?: string;
}

let suiteCounter = 0;

/** Poll until `cond` is true or timeout. */
export async function waitFor(
  cond: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within ' + timeoutMs + 'ms');
}

function env(
  room: string,
  sender: string,
  seq: number,
  session: string,
): Parameters<typeof createEnvelope>[1] {
  return { roomId: room, senderId: sender, sessionId: session, seq, ts: Date.now() };
}

/** offer/answer payload with an extra tag for ordering assertions. */
function taggedSdp(tag: string, sdp: string): OfferPayload {
  return { sdp, label: tag } as OfferPayload;
}

export function runAdapterTestSuite(h: AdapterHarness): void {
  describe(`@vidcall/transport shared suite → ${h.name}`, () => {
    it('join resolves and binds the room', async () => {
      const p = await h.createPeer('a');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await expect(p.join(r, { id: 'a', displayName: 'alice' })).resolves.toBeUndefined();
      await h.destroyPeer(p);
    });

    it('offer/answer round trip between two peers', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a', displayName: 'alice' });
      await b.join(r, { id: 'b', displayName: 'bob' });

      const bGot: Envelope[] = [];
      const aGot: Envelope[] = [];
      b.onMessage((e) => bGot.push(e));
      a.onMessage((e) => aGot.push(e));

      await a.emit(
        createEnvelope('offer', {
          ...env(r, 'a', 0, 's-a'),
          payload: { sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
        }),
      );
      await waitFor(() => bGot.length >= 1);
      expect(bGot[0]!.type).toBe('offer');
      expect(bGot[0]!.senderId).toBe('a');
      expect(bGot[0]!.roomId).toBe(r);
      expect(bGot[0]!.payload).toMatchObject({ sdp: expect.stringContaining('v=0') });

      await b.emit(
        createEnvelope('answer', {
          ...env(r, 'b', 0, 's-b'),
          payload: { sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
        }),
      );
      await waitFor(() => aGot.length >= 1);
      expect(aGot[0]!.type).toBe('answer');
      expect(aGot[0]!.senderId).toBe('b');

      await h.destroyPeer(a);
      await h.destroyPeer(b);
    });

    it('ordered burst of 10 messages arrives in order', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a' });
      await b.join(r, { id: 'b' });

      const got: string[] = [];
      b.onMessage((e) => got.push((e.payload as OfferPayload).label ?? ''));

      for (let i = 0; i < 10; i++) {
        await a.emit(
          createEnvelope('offer', {
            ...env(r, 'a', i, 's-a'),
            payload: taggedSdp(`m${i}`, `sdp-${i}`),
          }),
        );
      }
      await waitFor(() => got.length >= 10);
      expect(got).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);

      await h.destroyPeer(a);
      await h.destroyPeer(b);
    });

    it('ICE trickle burst of 30 candidates arrives intact', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a' });
      await b.join(r, { id: 'b' });

      const got: Envelope[] = [];
      b.onMessage((e) => got.push(e));

      for (let i = 0; i < 30; i++) {
        await a.emit(
          createEnvelope('ice', {
            ...env(r, 'a', i, 's-a'),
            payload: {
              candidate: `candidate:${i} 1 udp 2122260223 192.0.2.1 ${40000 + i} typ host`,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          }),
        );
      }
      await waitFor(() => got.length >= 30);
      const candidates = got.filter((e) => e.type === 'ice');
      expect(candidates.length).toBe(30);
      const seen = new Set(candidates.map((e) => (e.payload as { candidate: string }).candidate));
      expect(seen.size).toBe(30);

      await h.destroyPeer(a);
      await h.destroyPeer(b);
    });

    it('reaction fan-out to three peers', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const c = await h.createPeer('c');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a' });
      await b.join(r, { id: 'b' });
      await c.join(r, { id: 'c' });

      const bGot: Envelope[] = [];
      const cGot: Envelope[] = [];
      b.onMessage((e) => bGot.push(e));
      c.onMessage((e) => cGot.push(e));

      await a.emit(
        createEnvelope('reaction', {
          ...env(r, 'a', 0, 's-a'),
          payload: { emoji: '🔥', targetSenderId: 'b' },
        }),
      );
      await waitFor(() => bGot.length >= 1 && cGot.length >= 1);
      expect(bGot[0]!.payload).toMatchObject({ emoji: '🔥' });
      expect(cGot[0]!.payload).toMatchObject({ emoji: '🔥' });

      await h.destroyPeer(a);
      await h.destroyPeer(b);
      await h.destroyPeer(c);
    });

    it('presence: peer A visible to B after setPresence, updates propagate', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a', displayName: 'alice' });
      await b.join(r, { id: 'b', displayName: 'bob' });

      const seen: ParticipantPresence[] = [];
      b.onPresence((p) => seen.push(p));

      await a.setPresence('online', { name: 'alice', muted: false });
      await waitFor(() => seen.some((p) => p.participantId === 'a' && p.state === 'online'));
      const first = seen.find((p) => p.participantId === 'a')!;
      expect(first.metadata).toMatchObject({ name: 'alice', muted: false });

      await a.setPresence('busy', { name: 'alice', muted: true, camOn: true });
      await waitFor(() => seen.some((p) => p.participantId === 'a' && p.state === 'busy'));
      const updated = seen.find((p) => p.participantId === 'a' && p.state === 'busy')!;
      expect(updated.metadata).toMatchObject({ muted: true, camOn: true });

      await h.destroyPeer(a);
      await h.destroyPeer(b);
    });

    it('presence: leave reports the peer offline', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a' });
      await b.join(r, { id: 'b' });

      const seen: ParticipantPresence[] = [];
      b.onPresence((p) => seen.push(p));
      await a.setPresence('online', { name: 'alice' });
      await waitFor(() => seen.some((p) => p.participantId === 'a' && p.state === 'online'));

      await a.leave();
      await waitFor(() => seen.some((p) => p.participantId === 'a' && p.state === 'offline'));

      await h.destroyPeer(a);
      await h.destroyPeer(b);
    });

    it('two concurrent rooms are isolated', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const c = await h.createPeer('c');
      const d = await h.createPeer('d');
      const r1 = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      const r2 = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r1, { id: 'a' });
      await b.join(r1, { id: 'b' });
      await c.join(r2, { id: 'c' });
      await d.join(r2, { id: 'd' });

      const bGot: Envelope[] = [];
      const cGot: Envelope[] = [];
      const dGot: Envelope[] = [];
      b.onMessage((e) => bGot.push(e));
      c.onMessage((e) => cGot.push(e));
      d.onMessage((e) => dGot.push(e));

      await a.emit(
        createEnvelope('chat', { ...env(r1, 'a', 0, 's-a'), payload: { text: 'room1 only' } }),
      );
      await c.emit(
        createEnvelope('chat', { ...env(r2, 'c', 0, 's-c'), payload: { text: 'room2 only' } }),
      );

      await waitFor(() => bGot.length >= 1 && dGot.length >= 1);
      expect(bGot[0]!.payload).toMatchObject({ text: 'room1 only' });
      expect(dGot[0]!.payload).toMatchObject({ text: 'room2 only' });
      // cross-room leakage must not happen
      await new Promise((r) => setTimeout(r, 60));
      expect(cGot.length).toBe(0);
      expect(bGot.some((e) => (e.payload as { text: string }).text === 'room2 only')).toBe(false);
      expect(dGot.some((e) => (e.payload as { text: string }).text === 'room1 only')).toBe(false);

      await h.destroyPeer(a);
      await h.destroyPeer(b);
      await h.destroyPeer(c);
      await h.destroyPeer(d);
    });

    it('leave then re-join still works', async () => {
      const a = await h.createPeer('a');
      const b = await h.createPeer('b');
      const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
      await a.join(r, { id: 'a' });
      await b.join(r, { id: 'b' });

      const got: Envelope[] = [];
      b.onMessage((e) => got.push(e));

      await a.emit(
        createEnvelope('chat', { ...env(r, 'a', 0, 's-a'), payload: { text: 'before' } }),
      );
      await waitFor(() => got.length >= 1);

      await a.leave();
      await a.join(r, { id: 'a' });
      await a.emit(
        createEnvelope('chat', { ...env(r, 'a', 1, 's-a'), payload: { text: 'after' } }),
      );
      await waitFor(() => got.some((e) => (e.payload as { text: string }).text === 'after'));

      await h.destroyPeer(a);
      await h.destroyPeer(b);
    });

    it('emit requires a join and matching roomId', async () => {
      const a = await h.createPeer('a');
      await expect(
        a.emit(createEnvelope('chat', { ...env('nope', 'a', 0, 's-a'), payload: { text: 'x' } })),
      ).rejects.toThrow();
      await h.destroyPeer(a);
    });

    if (h.supportsLargePayload) {
      it('payload over the frame cap round-trips intact (chunking)', async () => {
        const a = await h.createPeer('a');
        const b = await h.createPeer('b');
        const r = `${h.roomPrefix ?? 'shared'}-r${++suiteCounter}`;
        await a.join(r, { id: 'a' });
        await b.join(r, { id: 'b' });

        const got: Envelope[] = [];
        b.onMessage((e) => got.push(e));

        // ~10 KB with multibyte chars — over the postgres 7 KB chunk threshold
        const big = '🏠'.repeat(2500) + 'x'.repeat(3000);
        await a.emit(createEnvelope('offer', { ...env(r, 'a', 0, 's-a'), payload: { sdp: big } }));

        await waitFor(() => got.length >= 1, 3000);
        expect(got[0]!.type).toBe('offer');
        expect((got[0]!.payload as { sdp: string }).sdp.length).toBe(big.length);
        expect((got[0]!.payload as { sdp: string }).sdp).toBe(big);

        await h.destroyPeer(a);
        await h.destroyPeer(b);
      });
    }
  });
}
