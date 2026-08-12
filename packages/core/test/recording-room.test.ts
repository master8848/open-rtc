import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { InMemoryTransport } from '../src/transport.ts';
import type { MediaRecorderConstructor } from '../src/recording/media-recorder-recording-hook.ts';
import type { CompositeRecordingStoppedEvent } from '../src/recording/composite-recording-hook.ts';
import type {
  RecordingChunk,
  RecordingStartedEvent,
  RecordingStoppedEvent,
} from '../src/recording/recording-hook.ts';
import { RecordingUnavailableError } from '../src/recording/recording-hook.ts';
import type { RecordingUploader } from '../src/recording/recording-uploader.ts';
import type { RecordingFetch, RecordingFetchInit } from '../src/recording/recording-uploader.ts';
import {
  FakeMediaRecorder,
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  resetFakeMediaRecorder,
  resetFakeRTC,
} from '../../test-utils/src/index.ts';
import { waitFor } from '../../test-utils/src/fixtures.ts';

beforeEach(() => {
  resetFakeRTC();
  resetFakeMediaRecorder();
});

const FakeMediaRecorderCtor = FakeMediaRecorder as unknown as MediaRecorderConstructor;

const stream = (kinds: Array<'audio' | 'video'> = ['video']): MediaStream =>
  new FakeMediaStream(
    kinds.map((kind) => new FakeMediaStreamTrack(kind)),
  ) as unknown as MediaStream;

/** In-memory RecordingUploader spy. */
class SpyUploader implements RecordingUploader {
  readonly chunks: Array<{ roomId: string; sessionId: string; chunk: RecordingChunk }> = [];
  readonly finalized: Array<{ roomId: string; sessionId: string; result: RecordingStoppedEvent }> =
    [];

  async uploadChunk(roomId: string, sessionId: string, chunk: RecordingChunk): Promise<void> {
    this.chunks.push({ roomId, sessionId, chunk });
  }

  async finalize(roomId: string, sessionId: string, result: RecordingStoppedEvent): Promise<void> {
    this.finalized.push({ roomId, sessionId, result });
  }
}

function wiredPeerFactories() {
  const byKey = new Map<string, FakeRTCPeerConnection>();
  const wire = (k1: string, k2: string) => {
    const f1 = byKey.get(k1);
    const f2 = byKey.get(k2);
    if (f1 && f2) {
      f1.linkTo(f2);
      f2.linkTo(f1);
    }
  };
  return (selfId: string) =>
    (remoteId: string): RTCPeerConnection => {
      const key = `${selfId}->${remoteId}`;
      const existing = byKey.get(key);
      if (existing) return existing as unknown as RTCPeerConnection;
      const pc = new FakeRTCPeerConnection();
      byKey.set(key, pc);
      wire(key, `${remoteId}->${selfId}`);
      return pc as unknown as RTCPeerConnection;
    };
}

function makeRoom(
  id: string,
  factory: (remoteId: string) => RTCPeerConnection,
  extra: Partial<ConstructorParameters<typeof Room>[0]> = {},
): { room: Room; transport: InMemoryTransport } {
  const transport = new InMemoryTransport();
  const room = new Room({
    roomId: 'room-1',
    selfId: id,
    displayName: `User ${id}`,
    transport,
    peerFactory: factory,
    recordingMediaRecorderCtor: FakeMediaRecorderCtor,
    ...extra,
  });
  return { room, transport };
}

function makeRoomPair(): {
  a: { room: Room; transport: InMemoryTransport };
  b: { room: Room; transport: InMemoryTransport };
} {
  const factories = wiredPeerFactories();
  const a = makeRoom('a', factories('a'));
  const b = makeRoom('b', factories('b'));
  return { a, b };
}

test('Room.recording: startRecording wires the composite hook + uploader to room events', async () => {
  const { a } = makeRoomPair();
  const uploader = new SpyUploader();
  const started: RecordingStartedEvent[] = [];
  const chunks: RecordingChunk[] = [];
  const stopped: CompositeRecordingStoppedEvent[] = [];
  a.room.on('recording:started', (e) => started.push(e));
  a.room.on('recording:blob-chunk', (c) => chunks.push(c));
  a.room.on('recording:stopped', (e) => stopped.push(e as CompositeRecordingStoppedEvent));

  await a.room.join();
  await a.room.recording.startRecording({
    localStream: stream(['video', 'audio']),
    remoteStreams: [{ participantId: 'alice', stream: stream() }],
    uploader,
  });
  assert.equal(a.room.recording.getState(), 'recording');
  assert.equal(started.length, 1);
  assert.equal(FakeMediaRecorder.instances.length, 2);

  const recorder = FakeMediaRecorder.instances[0]!;
  recorder.emitData(new Blob(['chunk-a'], { type: 'video/webm' }));
  await waitFor(() => chunks.length === 1 && uploader.chunks.length === 1);
  assert.equal(chunks[0]!.streamId, 'local');
  assert.equal(uploader.chunks[0]!.roomId, 'room-1');
  assert.equal(uploader.chunks[0]!.sessionId, a.room.sessionId);
  assert.equal(uploader.chunks[0]!.chunk, chunks[0]!);

  await a.room.recording.stopRecording();
  await waitFor(() => stopped.length === 1 && uploader.finalized.length === 1);
  assert.equal(a.room.recording.getState(), 'idle');
  assert.equal(stopped[0]!.results.length, 2);
  assert.equal(uploader.finalized[0]!.roomId, 'room-1');
  assert.equal(stopped[0]!.bytes, 7); // 'chunk-a'
  await a.room.leave();
});

test('Room.recording: remote stream is recorded as remote:<participantId>', async () => {
  const { a, b } = makeRoomPair();
  await a.room.join();
  await b.room.join();
  await waitFor(() => !!a.room.getParticipant('b') && !!b.room.getParticipant('a'));

  const track = new FakeMediaStreamTrack('video');
  await a.room.publish(track);
  await waitFor(() => b.room.getParticipant('a')?.publications.length === 1);

  const chunks: RecordingChunk[] = [];
  b.room.on('recording:blob-chunk', (c) => chunks.push(c));
  await b.room.recording.startRecording({
    remoteStreams: [{ participantId: 'a', stream: stream(['video']) }],
  });

  FakeMediaRecorder.instances[0]!.emitData(new Blob(['remote-bytes']));
  await waitFor(() => chunks.length === 1);
  assert.equal(chunks[0]!.streamId, 'remote:a');
  assert.equal(chunks[0]!.kind, 'remote');

  await b.room.recording.stopRecording();
  await a.room.leave();
  await b.room.leave();
});

test('Room.recording: recordingEndpoint config uploads via fetch', async () => {
  const calls: Array<{ url: string; init?: RecordingFetchInit }> = [];
  const fetchImpl: RecordingFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const { room } = makeRoom(
    'me',
    () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection,
    {
      recordingEndpoint: 'https://rec.example.com',
      recordingFetchImpl: fetchImpl,
    },
  );

  await room.join();
  await room.recording.startRecording({ localStream: stream() });
  FakeMediaRecorder.instances[0]!.emitData(new Blob(['x'], { type: 'video/webm' }));
  await waitFor(() => calls.some((c) => c.url.endsWith('/recordings/chunks')));

  await room.recording.stopRecording();
  await waitFor(() => calls.some((c) => c.url.endsWith('/recordings/finalize')));
  assert.ok(
    calls.some((c) => c.url.endsWith('/recordings/chunks')),
    'chunk uploaded',
  );
  assert.ok(
    calls.some((c) => c.url.endsWith('/recordings/finalize')),
    'finalize uploaded',
  );
  await room.leave();
});

test('Room.recording: leave() stops an in-progress recording', async () => {
  const { room } = makeRoom(
    'me',
    () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection,
  );
  await room.join();
  await room.recording.startRecording({ localStream: stream() });
  assert.equal(room.recording.getState(), 'recording');

  const stopped: RecordingStoppedEvent[] = [];
  room.on('recording:stopped', (e) => stopped.push(e));
  await room.leave();
  assert.equal(stopped.length, 1);
  assert.equal(room.recording.getState(), 'idle');
});

test('Room.recording: unavailable MediaRecorder rejects startRecording', async () => {
  // recordingMediaRecorderCtor: null + no global MediaRecorder => unavailable.
  const { room } = makeRoom(
    'me',
    () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection,
    { recordingMediaRecorderCtor: null },
  );
  await room.join();
  assert.equal(room.recording.getState(), 'unavailable');
  await assert.rejects(
    () => room.recording.startRecording({ localStream: stream() }),
    RecordingUnavailableError,
  );
  await room.leave();
});

test('Room.recording: pause/resume flow through the facade', async () => {
  const { room } = makeRoom(
    'me',
    () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection,
  );
  await room.join();
  await room.recording.startRecording({ localStream: stream() });
  const recorder = FakeMediaRecorder.instances[0]!;

  room.recording.pause();
  assert.equal(room.recording.getState(), 'paused');
  assert.equal(recorder.state, 'paused');

  room.recording.resume();
  assert.equal(room.recording.getState(), 'recording');
  assert.equal(recorder.state, 'recording');
  await room.recording.stopRecording();
  await room.leave();
});
