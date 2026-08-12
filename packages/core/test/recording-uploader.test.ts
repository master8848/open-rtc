import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecordingChunk, RecordingStoppedEvent } from '../src/recording/recording-hook.ts';
import {
  FetchRecordingUploader,
  RecordingUploadError,
} from '../src/recording/recording-uploader.ts';
import type { RecordingFetch, RecordingFetchInit } from '../src/recording/recording-uploader.ts';

function mockFetch(calls: Array<{ url: string; init?: RecordingFetchInit }>): RecordingFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
}

const chunk: RecordingChunk = {
  index: 3,
  blob: new Blob(['chunk-bytes'], { type: 'video/webm' }),
  mimeType: 'video/webm',
  timestampMs: 1234,
  streamId: 'local',
  label: 'Local',
  kind: 'local',
};

const result: RecordingStoppedEvent = {
  blob: new Blob(['all'], { type: 'video/webm' }),
  chunkCount: 4,
  bytes: 100,
  startedAtMs: 1000,
  stoppedAtMs: 5000,
  durationMs: 4000,
};

test('FetchRecordingUploader: uploadChunk POSTs the chunk blob to the recordings endpoint', async () => {
  const calls: Array<{ url: string; init?: RecordingFetchInit }> = [];
  const uploader = new FetchRecordingUploader({
    endpoint: 'https://vidcall.example.com/',
    fetchImpl: mockFetch(calls),
  });

  await uploader.uploadChunk('room-1', 'session-9', chunk);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    'https://vidcall.example.com/rooms/room-1/sessions/session-9/recordings/chunks',
  );
  assert.equal(calls[0]!.init!.method, 'POST');
  assert.equal(calls[0]!.init!.headers!['Content-Type'], 'video/webm');
  assert.equal(calls[0]!.init!.headers!['X-Recording-Chunk-Index'], '3');
  assert.equal(calls[0]!.init!.headers!['X-Recording-Stream-Id'], 'local');
  assert.equal(calls[0]!.init!.headers!['X-Recording-Timestamp-Ms'], '1234');
  assert.equal(calls[0]!.init!.body, chunk.blob);
});

test('FetchRecordingUploader: finalize POSTs the summary JSON', async () => {
  const calls: Array<{ url: string; init?: RecordingFetchInit }> = [];
  const uploader = new FetchRecordingUploader({
    endpoint: 'https://vidcall.example.com',
    fetchImpl: mockFetch(calls),
  });

  await uploader.finalize('room-1', 'session-9', result);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    'https://vidcall.example.com/rooms/room-1/sessions/session-9/recordings/finalize',
  );
  assert.equal(calls[0]!.init!.headers!['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0]!.init!.body as string);
  assert.equal(body.roomId, 'room-1');
  assert.equal(body.sessionId, 'session-9');
  assert.equal(body.chunkCount, 4);
  assert.equal(body.bytes, 100);
  assert.equal(body.durationMs, 4000);
  assert.equal(body.streams.length, 1);
  assert.equal(body.streams[0]!.mimeType, 'video/webm');
});

test('FetchRecordingUploader: non-2xx responses reject with RecordingUploadError', async () => {
  const failing: RecordingFetch = async () => ({ ok: false, status: 503 });
  const uploader = new FetchRecordingUploader({
    endpoint: 'https://x.example.com',
    fetchImpl: failing,
  });
  await assert.rejects(() => uploader.uploadChunk('r', 's', chunk), /HTTP 503/);
  await assert.rejects(() => uploader.finalize('r', 's', result), /HTTP 503/);
});

test('FetchRecordingUploader: missing fetch rejects with RecordingUploadError', async () => {
  const uploader = new FetchRecordingUploader({
    endpoint: 'https://x.example.com',
    fetchImpl: null, // explicit "no fetch available" (tests)
  });
  await assert.rejects(() => uploader.uploadChunk('r', 's', chunk), RecordingUploadError);
  await assert.rejects(() => uploader.finalize('r', 's', result), RecordingUploadError);
});

test('FetchRecordingUploader: pathFor customizes the endpoint path', async () => {
  const calls: Array<{ url: string; init?: RecordingFetchInit }> = [];
  const uploader = new FetchRecordingUploader({
    endpoint: 'https://x.example.com/',
    pathFor: () => 'recordings/abc',
    fetchImpl: mockFetch(calls),
  });
  await uploader.uploadChunk('r', 's', chunk);
  assert.equal(calls[0]!.url, 'https://x.example.com/recordings/abc/chunks');
});

test('FetchRecordingUploader: configured headers are merged into every request', async () => {
  const calls: Array<{ url: string; init?: RecordingFetchInit }> = [];
  const uploader = new FetchRecordingUploader({
    endpoint: 'https://x.example.com',
    headers: { Authorization: 'Bearer tok', 'X-Client': 'vidcall-core' },
    fetchImpl: mockFetch(calls),
  });
  await uploader.uploadChunk('r', 's', chunk);
  assert.equal(calls[0]!.init!.headers!['Authorization'], 'Bearer tok');
  assert.equal(calls[0]!.init!.headers!['X-Client'], 'vidcall-core');
  assert.equal(calls[0]!.init!.headers!['Content-Type'], 'video/webm');
});

test('FetchRecordingUploader: endpoint is required', () => {
  assert.throws(() => new FetchRecordingUploader({ endpoint: '' }), /endpoint is required/);
});
