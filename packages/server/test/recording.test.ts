import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DiskRecordingStorage, S3RecordingStorage } from '../src/recording.ts';
import { signV4, uriEncode } from '../src/aws-sigv4.ts';

test('recording: DiskRecordingStorage round-trip with out-of-order chunks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-disk-'));
  const storage = new DiskRecordingStorage({ dir });
  const session = 'rec-1';
  const chunks = [Buffer.from('chunk-zero-'), Buffer.from('chunk-one-'), Buffer.from('chunk-two')];

  // Save out of order to prove index ordering wins.
  await storage.saveChunk(session, chunks[2]!, 2);
  await storage.saveChunk(session, chunks[0]!, 0);
  await storage.saveChunk(session, chunks[1]!, 1);

  const before = await storage.finalize(session);
  assert.deepEqual(before, { chunks: 3, bytes: chunks.reduce((n, c) => n + c.length, 0) });

  const stream = await storage.getStream(session);
  const out = await collect(stream);
  assert.equal(Buffer.compare(out, Buffer.concat(chunks)), 0);

  // Manifest written to disk
  const manifest = JSON.parse(await readFile(path.join(dir, session, 'manifest.json'), 'utf8')) as {
    chunks: number;
    bytes: number;
  };
  assert.equal(manifest.chunks, 3);

  await storage.delete(session);
});

test('recording: getStream before finalize errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vidcall-disk2-'));
  const storage = new DiskRecordingStorage({ dir });
  await storage.saveChunk('rec-2', Buffer.from('x'), 0);
  await assert.rejects(
    storage.getStream('rec-2'),
    (err: unknown) => (err as { code?: string }).code === 'recording_storage_error',
  );
});

test('sigv4: deterministic signature with the expected Authorization shape', () => {
  const req1 = signV4({
    method: 'PUT',
    url: 'https://example-bucket.s3.us-east-1.amazonaws.com/recordings/rec-1/chunk-000000',
    body: Buffer.from('hello'),
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETEXAMPLE',
    region: 'us-east-1',
    service: 's3',
    amzDate: '20260812T000000Z',
    headers: { 'content-type': 'application/octet-stream' },
  });
  const req2 = signV4({
    method: 'PUT',
    url: 'https://example-bucket.s3.us-east-1.amazonaws.com/recordings/rec-1/chunk-000000',
    body: Buffer.from('hello'),
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETEXAMPLE',
    region: 'us-east-1',
    service: 's3',
    amzDate: '20260812T000000Z',
    headers: { 'content-type': 'application/octet-stream' },
  });
  // Deterministic for identical inputs.
  assert.equal(req1.headers.Authorization, req2.headers.Authorization);
  const auth = req1.headers.Authorization!;
  assert.match(
    auth,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260812\/us-east-1\/s3\/aws4_request, SignedHeaders=/,
  );
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
  assert.equal(req1.headers['x-amz-date'], '20260812T000000Z');
  assert.equal(req1.headers['x-amz-content-sha256']!.length, 64);
  assert.match(req1.headers['content-type']!, /^application\/octet-stream$/);
  assert.ok(req1.headers.host);
  // Different body → different signature.
  const req3 = signV4({
    method: 'PUT',
    url: 'https://example-bucket.s3.us-east-1.amazonaws.com/recordings/rec-1/chunk-000000',
    body: Buffer.from('hello!'),
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETEXAMPLE',
    region: 'us-east-1',
    service: 's3',
    amzDate: '20260812T000000Z',
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.notEqual(req1.headers.Authorization, req3.headers.Authorization);
});

test('sigv4: uriEncode follows RFC 3986 (space → %20, reserved chars percent-encoded)', () => {
  assert.equal(uriEncode('a b/c'), 'a%20b%2Fc');
  assert.equal(uriEncode('a+b'), 'a%2Bb');
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(uriEncode('simple'), 'simple');
});

/** Minimal S3-compatible server for the fetch-based client. */
async function mockS3Server(): Promise<{
  base: string;
  close(): Promise<void>;
  objects: Map<string, Buffer>;
}> {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''));
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200, { 'content-length': '0' });
        res.end();
      } else if (req.method === 'GET') {
        const value = objects.get(key);
        if (!value) {
          res.writeHead(404);
          res.end('NoSuchKey');
          return;
        }
        res.writeHead(200, {
          'content-length': String(value.length),
          'content-type': 'application/octet-stream',
        });
        res.end(value);
      } else if (req.method === 'HEAD') {
        const value = objects.get(key);
        if (!value) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': String(value.length) });
        res.end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(405);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    objects,
  };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) out.push(chunk);
  return Buffer.concat(out);
}

test('s3: S3RecordingStorage round-trip against a mock S3 server', async () => {
  const s3 = await mockS3Server();
  const storage = new S3RecordingStorage({
    endpoint: s3.base,
    bucket: 'bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETEXAMPLE',
    forcePathStyle: true,
    prefix: 'recordings',
    fetchImpl: fetch,
  });
  try {
    await storage.saveChunk('rec-3', Buffer.from('aaa'), 0);
    await storage.saveChunk('rec-3', Buffer.from('bbb'), 1);
    const totals = await storage.finalize('rec-3');
    assert.deepEqual(totals, { chunks: 2, bytes: 6 });

    const stream = await storage.getStream('rec-3');
    assert.equal(Buffer.compare(await collect(stream), Buffer.from('aaabbb')), 0);

    // Objects landed under prefix/sessionId/
    const keys = [...s3.objects.keys()].sort();
    assert.deepEqual(keys, [
      'recordings/rec-3/chunk-000000',
      'recordings/rec-3/chunk-000001',
      'recordings/rec-3/manifest.json',
    ]);

    // Deleting removes the manifest + chunks.
    await storage.delete('rec-3');
    assert.equal(s3.objects.size, 0);
  } finally {
    await s3.close();
  }
});

test('s3: missing chunks error on finalize', async () => {
  const s3 = await mockS3Server();
  const storage = new S3RecordingStorage({
    endpoint: s3.base,
    bucket: 'bucket',
    region: 'us-east-1',
    accessKeyId: 'a',
    secretAccessKey: 'b',
    forcePathStyle: true,
    fetchImpl: fetch,
  });
  try {
    await assert.rejects(
      storage.finalize('rec-empty'),
      (err: unknown) => (err as { code?: string }).code === 'recording_storage_error',
    );
  } finally {
    await s3.close();
  }
});

test('sigv4: default amzDate is compact YYYYMMDDTHHMMSSZ (no millis)', () => {
  const req = signV4({
    method: 'PUT',
    url: 'https://example-bucket.s3.us-east-1.amazonaws.com/recordings/rec-1/chunk-000000',
    body: Buffer.from('hello'),
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETEXAMPLE',
    region: 'us-east-1',
    service: 's3',
  });
  const date = req.headers['x-amz-date']!;
  assert.match(date, /^\d{8}T\d{6}Z$/);
});
