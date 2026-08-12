/**
 * vidcall server example — REST client snippet.
 *
 * Exercises the room lifecycle against the example server:
 * create a room, join two participants, relay one signal envelope, read state.
 *
 *   node examples/server/server.mjs   # terminal 1
 *   node examples/server/client.mjs   # terminal 2
 */
const base = 'http://localhost:3000/vidcall';

async function request(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

// 1. Create a room (or re-use an existing id).
const { room } = await request('/rooms', {
  method: 'POST',
  body: JSON.stringify({ roomId: 'demo', maxParticipants: 4 }),
});
console.log('room:', room.roomId, '(state:', room.state + ')');

// 2. Two participants join.
const alice = await request(`/rooms/${room.roomId}/join`, {
  method: 'POST',
  body: JSON.stringify({ participantId: 'alice', sessionId: 's-a', displayName: 'Alice' }),
});
const bob = await request(`/rooms/${room.roomId}/join`, {
  method: 'POST',
  body: JSON.stringify({ participantId: 'bob', sessionId: 's-b', displayName: 'Bob' }),
});
console.log('participants:', bob.participants.map((p) => p.displayName).join(', '));

// 3. Relay one protocol envelope (SDP offer from alice). See
//    protocol/schema.json for the envelope shape.
const signal = await request(`/rooms/${room.roomId}/signal`, {
  method: 'POST',
  body: JSON.stringify({
    v: 1,
    type: 'offer',
    roomId: room.roomId,
    senderId: 'alice',
    sessionId: 's-a',
    ts: Date.now(),
    seq: 0,
    targetSenderId: 'bob',
    payload: { sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
  }),
});
console.log('signal relayed:', JSON.stringify(signal));

// 4. Read room state.
const state = await request(`/rooms/${room.roomId}/state`);
console.log('state:', state.room.roomId, 'signalCount:', state.signalCount);
