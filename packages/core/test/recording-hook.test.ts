import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeMediaRecorder,
  FakeMediaStream,
  FakeMediaStreamTrack,
  resetFakeMediaRecorder,
} from '../../test-utils/src/index.ts';
import { MediaRecorderRecordingHook } from '../src/recording/media-recorder-recording-hook.ts';
import type { MediaRecorderConstructor } from '../src/recording/media-recorder-recording-hook.ts';
import {
  probeMimeType,
  DEFAULT_RECORDING_MIME_TYPES,
} from '../src/recording/media-recorder-recording-hook.ts';
import type { RecordingChunk, RecordingErrorEvent } from '../src/recording/recording-hook.ts';
import { RecordingUnavailableError } from '../src/recording/recording-hook.ts';

beforeEach(() => resetFakeMediaRecorder());

const FakeMediaRecorderCtor = FakeMediaRecorder as unknown as MediaRecorderConstructor;

const stream = (): MediaStream =>
  new FakeMediaStream([new FakeMediaStreamTrack('video')]) as unknown as MediaStream;

test('MediaRecorderRecordingHook: start probes MIME, records chunks, stop assembles a Blob', async () => {
  let nowMs = 1000;
  const hook = new MediaRecorderRecordingHook({
    stream: stream(),
    mediaRecorderCtor: FakeMediaRecorderCtor,
    now: () => nowMs,
  });
  const started: Array<{ startedAtMs: number; mimeType?: string }> = [];
  const chunks: RecordingChunk[] = [];
  hook.on('recording:started', (e) => started.push(e));
  hook.on('recording:blob-chunk', (c) => chunks.push(c));

  const startedEvent = await hook.start();
  assert.equal(hook.getState(), 'recording');
  assert.equal(started.length, 1);
  assert.equal(startedEvent.startedAtMs, 1000);
  assert.equal(startedEvent.mimeType, 'video/webm;codecs=vp9,opus');

  const recorder = FakeMediaRecorder.instances[0]!;
  assert.equal(recorder.mimeType, 'video/webm;codecs=vp9,opus');

  nowMs = 1500;
  recorder.emitData(new Blob(['part-1'], { type: 'video/webm' }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.index, 0);
  assert.equal(chunks[0]!.timestampMs, 500);
  assert.equal(await chunks[0]!.blob.text(), 'part-1');

  nowMs = 2000;
  recorder.emitData(new Blob(['part-2'], { type: 'video/webm' }));
  assert.equal(chunks[1]!.index, 1);
  assert.equal(chunks[1]!.timestampMs, 1000);

  const stopped = await hook.stop();
  assert.ok(stopped, 'stop resolves with a report');
  assert.equal(hook.getState(), 'idle');
  assert.equal(stopped!.chunkCount, 2);
  assert.equal(stopped!.bytes, 12);
  assert.equal(await stopped!.blob!.text(), 'part-1part-2');
  assert.equal(stopped!.durationMs, 1000); // 2000 - 1000
});

test('MediaRecorderRecordingHook: pause/resume transition both recorder and hook', async () => {
  const hook = new MediaRecorderRecordingHook({
    stream: stream(),
    mediaRecorderCtor: FakeMediaRecorderCtor,
    now: () => 0,
  });
  await hook.start();
  const recorder = FakeMediaRecorder.instances[0]!;

  hook.pause();
  assert.equal(hook.getState(), 'paused');
  assert.equal(recorder.state, 'paused');

  hook.resume();
  assert.equal(hook.getState(), 'recording');
  assert.equal(recorder.state, 'recording');

  await hook.stop();
  assert.equal(hook.getState(), 'idle');
  assert.throws(() => hook.pause(), /cannot pause in state 'idle'/);
  assert.throws(() => hook.resume(), /cannot resume in state 'idle'/);
});

test('MediaRecorderRecordingHook: unavailable environment reports state and rejects start', async () => {
  const hook = new MediaRecorderRecordingHook({ stream: stream(), supported: false });
  assert.equal(hook.getState(), 'unavailable');
  await assert.rejects(() => hook.start(), RecordingUnavailableError);
  assert.equal(hook.getState(), 'unavailable');
  assert.equal(await hook.stop(), undefined);
});

test('MediaRecorderRecordingHook: missing global MediaRecorder never crashes the hook', () => {
  // Node has no MediaRecorder unless test-utils installed it: the hook must
  // construct fine and simply report the unavailable state.
  const hook = new MediaRecorderRecordingHook({ stream: stream() });
  assert.equal(hook.getState(), 'unavailable');
});

test('MediaRecorderRecordingHook: can start again after stop with a fresh session', async () => {
  const hook = new MediaRecorderRecordingHook({
    stream: stream(),
    mediaRecorderCtor: FakeMediaRecorderCtor,
    now: () => 0,
  });
  await hook.start();
  FakeMediaRecorder.instances[0]!.emitData(new Blob(['first-session']));
  await hook.stop();

  const chunks: RecordingChunk[] = [];
  hook.on('recording:blob-chunk', (c) => chunks.push(c));
  await hook.start();
  const secondRecorder = FakeMediaRecorder.instances[1]!;
  secondRecorder.emitData(new Blob(['second']));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.index, 0, 'chunk index resets per session');

  const stopped = await hook.stop();
  assert.equal(await stopped!.blob!.text(), 'second');
  assert.equal(stopped!.chunkCount, 1);
});

test('MediaRecorderRecordingHook: creates an in-memory object URL when requested', async () => {
  const original = (URL as { createObjectURL?: (blob: Blob) => string }).createObjectURL;
  (URL as { createObjectURL: (blob: Blob) => string }).createObjectURL = (blob) =>
    `blob:fake-${blob.size}`;
  try {
    const hook = new MediaRecorderRecordingHook({
      stream: stream(),
      mediaRecorderCtor: FakeMediaRecorderCtor,
      createObjectUrl: true,
      now: () => 0,
    });
    await hook.start();
    FakeMediaRecorder.instances[0]!.emitData(new Blob(['data']));
    const stopped = await hook.stop();
    assert.equal(stopped!.objectUrl, 'blob:fake-4');
    assert.equal(stopped!.blob!.size, 4);
  } finally {
    if (original) {
      (URL as { createObjectURL?: (blob: Blob) => string }).createObjectURL = original;
    } else {
      delete (URL as { createObjectURL?: (blob: Blob) => string }).createObjectURL;
    }
  }
});

test('MediaRecorderRecordingHook: recorder error emits recording:error and rejects pending stop', async () => {
  const hook = new MediaRecorderRecordingHook({
    stream: stream(),
    mediaRecorderCtor: FakeMediaRecorderCtor,
    now: () => 0,
  });
  const errors: RecordingErrorEvent[] = [];
  hook.on('recording:error', (e) => errors.push(e));

  await hook.start();
  const stopPromise = hook.stop();
  FakeMediaRecorder.instances[0]!.fail(new Error('recorder exploded'));

  await assert.rejects(() => stopPromise, /recorder exploded/);
  assert.equal(hook.getState(), 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'recorder');
});

test('MediaRecorderRecordingHook: constructor failure emits recording:error and rethrows', async () => {
  class BoomRecorder extends FakeMediaRecorder {
    constructor(recStream: MediaStream, options?: MediaRecorderOptions) {
      if (options?.mimeType?.includes('vp9')) {
        throw new DOMException('vp9 is not available on this device', 'NotSupportedError');
      }
      super(recStream, options);
    }
  }
  const hook = new MediaRecorderRecordingHook({
    stream: stream(),
    mimeTypes: ['video/webm;codecs=vp9,opus', 'video/webm'],
    mediaRecorderCtor: BoomRecorder as unknown as MediaRecorderConstructor,
  });
  const errors: RecordingErrorEvent[] = [];
  hook.on('recording:error', (e) => errors.push(e));

  await assert.rejects(() => hook.start(), /vp9 is not available/);
  assert.equal(hook.getState(), 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'recorder');
});

test('probeMimeType: prefers vp9, falls back to vp8, then container default', () => {
  assert.equal(
    probeMimeType(DEFAULT_RECORDING_MIME_TYPES, FakeMediaRecorderCtor),
    'video/webm;codecs=vp9,opus',
  );

  FakeMediaRecorder.supportedMimeTypes = ['video/webm;codecs=vp8,opus'];
  assert.equal(
    probeMimeType(DEFAULT_RECORDING_MIME_TYPES, FakeMediaRecorderCtor),
    'video/webm;codecs=vp8,opus',
  );

  FakeMediaRecorder.supportedMimeTypes = ['video/webm'];
  assert.equal(probeMimeType(DEFAULT_RECORDING_MIME_TYPES, FakeMediaRecorderCtor), 'video/webm');

  FakeMediaRecorder.supportedMimeTypes = [];
  assert.equal(probeMimeType(DEFAULT_RECORDING_MIME_TYPES, FakeMediaRecorderCtor), '');
});

test('probeMimeType: no constructor / no isTypeSupported means platform default', () => {
  assert.equal(probeMimeType(DEFAULT_RECORDING_MIME_TYPES, undefined), '');
  assert.equal(
    probeMimeType(DEFAULT_RECORDING_MIME_TYPES, {} as unknown as MediaRecorderConstructor),
    '',
  );
});
