import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeMediaRecorder,
  FakeMediaStream,
  FakeMediaStreamTrack,
  resetFakeMediaRecorder,
} from '../src/index.ts';

beforeEach(() => resetFakeMediaRecorder());

const videoStream = (): MediaStream =>
  new FakeMediaStream([new FakeMediaStreamTrack('video')]) as unknown as MediaStream;

test('FakeMediaRecorder: isTypeSupported probes the supported MIME list', () => {
  assert.equal(FakeMediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'), true);
  assert.equal(FakeMediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'), true);
  assert.equal(FakeMediaRecorder.isTypeSupported('video/webm'), true);
  assert.equal(FakeMediaRecorder.isTypeSupported('video/mp4'), false);
});

test('FakeMediaRecorder: start/pause/resume/stop state transitions', async () => {
  const recorder = new FakeMediaRecorder(videoStream());
  assert.equal(recorder.state, 'inactive');
  recorder.start(1000);
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.timeslice, 1000);
  recorder.pause();
  assert.equal(recorder.state, 'paused');
  recorder.resume();
  assert.equal(recorder.state, 'recording');
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });
  assert.equal(recorder.state, 'inactive');
});

test('FakeMediaRecorder: stop fires a final dataavailable then stop (microtasks)', async () => {
  const recorder = new FakeMediaRecorder(videoStream());
  const order: string[] = [];
  recorder.ondataavailable = (ev) => order.push(`data:${ev.data.size}`);
  recorder.onstop = () => order.push('stop');
  recorder.start(1000);
  recorder.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['data:0', 'stop']);
});

test('FakeMediaRecorder: emitData fires ondataavailable with the blob', async () => {
  const recorder = new FakeMediaRecorder(videoStream());
  const seen: Blob[] = [];
  recorder.ondataavailable = (ev) => seen.push(ev.data);
  recorder.start(1000);
  recorder.emitData(new Blob(['chunk'], { type: 'video/webm' }));
  assert.equal(seen.length, 1);
  assert.equal(await seen[0]!.text(), 'chunk');
  assert.equal(seen[0]!.type, 'video/webm');
});

test('FakeMediaRecorder: constructor rejects unsupported MIME and empty streams', () => {
  assert.throws(
    () => new FakeMediaRecorder(videoStream(), { mimeType: 'video/mp4' }),
    /not supported/,
  );
  assert.throws(
    () => new FakeMediaRecorder(new FakeMediaStream([]) as unknown as MediaStream),
    /no tracks/,
  );
});

test('FakeMediaRecorder: instances are tracked and reset between tests', () => {
  new FakeMediaRecorder(videoStream());
  assert.equal(FakeMediaRecorder.instances.length, 1);
  resetFakeMediaRecorder();
  assert.equal(FakeMediaRecorder.instances.length, 0);
  assert.deepEqual(
    FakeMediaRecorder.supportedMimeTypes,
    FakeMediaRecorder.defaultSupportedMimeTypes,
  );
});
