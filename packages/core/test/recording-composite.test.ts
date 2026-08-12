import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeMediaRecorder,
  FakeMediaStream,
  FakeMediaStreamTrack,
  resetFakeMediaRecorder,
} from '../../test-utils/src/index.ts';
import { CompositeRecordingHook } from '../src/recording/composite-recording-hook.ts';
import type { CompositeRecordingStartedEvent } from '../src/recording/composite-recording-hook.ts';
import type { MediaRecorderConstructor } from '../src/recording/media-recorder-recording-hook.ts';
import type { RecordingChunk, RecordingErrorEvent } from '../src/recording/recording-hook.ts';
import { RecordingUnavailableError } from '../src/recording/recording-hook.ts';

beforeEach(() => resetFakeMediaRecorder());

const FakeMediaRecorderCtor = FakeMediaRecorder as unknown as MediaRecorderConstructor;

const stream = (kinds: Array<'audio' | 'video'> = ['video']): MediaStream =>
  new FakeMediaStream(
    kinds.map((kind) => new FakeMediaStreamTrack(kind)),
  ) as unknown as MediaStream;

test('CompositeRecordingHook: records local + remote streams on one shared timeline', async () => {
  let nowMs = 10_000;
  const now = () => nowMs;
  const hook = new CompositeRecordingHook({ now, mediaRecorderCtor: FakeMediaRecorderCtor });
  const chunks: RecordingChunk[] = [];
  const startedEvents: CompositeRecordingStartedEvent[] = [];
  hook.on('recording:blob-chunk', (c) => chunks.push(c));
  hook.on('recording:started', (e) => startedEvents.push(e as CompositeRecordingStartedEvent));

  const started = await hook.start({
    localStream: stream(['video', 'audio']),
    remoteStreams: [
      { participantId: 'alice', stream: stream() },
      { participantId: 'bob', stream: stream() },
    ],
  });

  assert.equal(hook.getState(), 'recording');
  assert.equal(startedEvents.length, 1);
  assert.equal(started.startedAtMs, 10_000);
  assert.deepEqual(
    started.streams.map((s) => s.streamId),
    ['local', 'remote:alice', 'remote:bob'],
  );
  assert.deepEqual(
    started.streams.map((s) => s.kind),
    ['local', 'remote', 'remote'],
  );
  assert.equal(FakeMediaRecorder.instances.length, 3);

  // Common timeline: chunks from different streams are aligned to the same origin.
  const localRecorder = FakeMediaRecorder.instances[0]!;
  const aliceRecorder = FakeMediaRecorder.instances[1]!;

  nowMs = 10_500;
  localRecorder.emitData(new Blob(['local-one'], { type: 'video/webm' }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.streamId, 'local');
  assert.equal(chunks[0]!.kind, 'local');
  assert.equal(chunks[0]!.timestampMs, 500);

  nowMs = 11_000;
  aliceRecorder.emitData(new Blob(['alice-one'], { type: 'video/webm' }));
  assert.equal(chunks[1]!.streamId, 'remote:alice');
  assert.equal(chunks[1]!.kind, 'remote');
  assert.equal(chunks[1]!.timestampMs, 1000);

  // pause/resume apply to every stream recorder.
  hook.pause();
  assert.equal(hook.getState(), 'paused');
  assert.equal(localRecorder.state, 'paused');
  assert.equal(aliceRecorder.state, 'paused');
  hook.resume();
  assert.equal(hook.getState(), 'recording');
  assert.equal(localRecorder.state, 'recording');

  const stopped = await hook.stop();
  assert.ok(stopped);
  assert.equal(stopped!.results.length, 3);
  assert.equal(stopped!.chunkCount, 2);
  assert.equal(stopped!.bytes, 18); // 'local-one' (9) + 'alice-one' (9)
  assert.equal(await stopped!.results[0]!.blob!.text(), 'local-one');
  assert.equal(stopped!.durationMs, 1000);
  assert.equal(hook.getState(), 'idle');
  assert.deepEqual(hook.getStreamIds(), []);
});

test('CompositeRecordingHook: start without streams throws', async () => {
  const hook = new CompositeRecordingHook({ mediaRecorderCtor: FakeMediaRecorderCtor });
  await assert.rejects(() => hook.start(), /no streams to record/);
  assert.equal(hook.getState(), 'idle');
});

test('CompositeRecordingHook: unavailable environment rejects start', async () => {
  const hook = new CompositeRecordingHook({ supported: false });
  assert.equal(hook.getState(), 'unavailable');
  await assert.rejects(() => hook.start({ localStream: stream() }), RecordingUnavailableError);
});

test('CompositeRecordingHook: addRemoteStream joins the existing timeline mid-call', async () => {
  let nowMs = 6000;
  const hook = new CompositeRecordingHook({
    now: () => nowMs,
    mediaRecorderCtor: FakeMediaRecorderCtor,
  });
  await hook.start({ localStream: stream() });
  assert.equal(FakeMediaRecorder.instances.length, 1);

  const chunks: RecordingChunk[] = [];
  hook.on('recording:blob-chunk', (c) => chunks.push(c));

  nowMs = 7000;
  await hook.addRemoteStream(stream(), 'carol');
  assert.equal(FakeMediaRecorder.instances.length, 2);

  nowMs = 7500;
  FakeMediaRecorder.instances[1]!.emitData(new Blob(['carol-bytes']));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.streamId, 'remote:carol');
  // Composite started at t=6000; carol's chunk at t=7500 => 1500ms on the shared timeline.
  assert.equal(chunks[0]!.timestampMs, 1500);

  const stopped = await hook.stop();
  assert.equal(stopped!.results.length, 2);
  assert.equal(await stopped!.results[1]!.blob!.text(), 'carol-bytes');
});

test('CompositeRecordingHook: removeRemoteStream stops just that stream', async () => {
  const hook = new CompositeRecordingHook({
    now: () => 0,
    mediaRecorderCtor: FakeMediaRecorderCtor,
  });
  await hook.start({
    localStream: stream(),
    remoteStreams: [{ participantId: 'alice', stream: stream() }],
  });
  assert.deepEqual(hook.getStreamIds(), ['local', 'remote:alice']);

  const stopped = await hook.removeRemoteStream('remote:alice');
  assert.ok(stopped);
  assert.equal(stopped!.streamId, 'remote:alice');
  assert.deepEqual(hook.getStreamIds(), ['local']);
  assert.equal(hook.getState(), 'recording');
  await hook.stop();
});

test('CompositeRecordingHook: forwards sub-recorder errors tagged with streamId', async () => {
  const hook = new CompositeRecordingHook({
    now: () => 0,
    mediaRecorderCtor: FakeMediaRecorderCtor,
  });
  await hook.start({
    localStream: stream(),
    remoteStreams: [{ participantId: 'alice', stream: stream() }],
  });
  const errors: RecordingErrorEvent[] = [];
  hook.on('recording:error', (e) => errors.push(e));

  FakeMediaRecorder.instances[1]!.fail(new Error('alice encoder died'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.streamId, 'remote:alice');
  assert.equal(hook.getState(), 'error');

  // The healthy stream still stops cleanly.
  const stopped = await hook.stop();
  assert.equal(stopped!.results.length, 1);
  assert.equal(stopped!.results[0]!.streamId, 'local');
});

test('CompositeRecordingHook: custom streams option gives full control', async () => {
  const hook = new CompositeRecordingHook({
    now: () => 0,
    mediaRecorderCtor: FakeMediaRecorderCtor,
  });
  const started = await hook.start({
    streams: [
      { id: 'screen', stream: stream(['video']), kind: 'remote', label: 'Shared screen' },
      { id: 'local', stream: stream(['audio']), kind: 'local', label: 'Mic' },
    ],
  });
  assert.deepEqual(
    started.streams.map((s) => s.streamId),
    ['screen', 'local'],
  );
  assert.equal(started.streams[0]!.label, 'Shared screen');
  assert.equal(started.streams[1]!.kind, 'local');
  await hook.stop();
});
