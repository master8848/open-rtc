/**
 * Minimal AWS Signature Version 4 (SigV4) request signer — enough for
 * S3 `PutObject` / `GetObject` / `DeleteObject` over `fetch`, with no AWS
 * SDK dependency. Implements the algorithm from
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 *
 * Only header-based auth (`Authorization` header) is supported; query
 * strings are canonicalized but only used for object keys that may contain
 * query characters (rare for recording chunks).
 */

import { createHash, createHmac } from 'node:crypto';

export interface SignV4Options {
  method: string;
  /** Absolute URL (scheme://host/path?query). */
  url: string;
  /** Canonical headers to sign. `host` is added automatically. */
  headers?: Record<string, string>;
  /** Request body bytes (hashed into the signature). */
  body?: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** ISO8601 `YYYYMMDDTHHMMSSZ`; defaults to now. */
  amzDate?: string;
}

export interface SignedRequest {
  /** Headers to send, including `Authorization`, `x-amz-date`, `host`. */
  headers: Record<string, string>;
  /** The `x-amz-date` used (useful for tests + retries). */
  amzDate: string;
}

/** RFC 3986 encode (S3 wants `%20` for spaces, not `+`). */
export function uriEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function canonicalQuery(url: URL): string {
  const parts: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    parts.push(`${uriEncode(key)}=${uriEncode(value)}`);
  }
  return parts.sort().join('&');
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const keys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonical = keys
    .map((k) => `${k}:${headers[keys.find((kk) => kk === k)!]!.trim().replace(/\s+/g, ' ')}`)
    .join('\n');
  return { canonical, signed: keys.join(';') };
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Sign a request; returns headers ready to attach to a fetch() call. */
export function signV4(opts: SignV4Options): SignedRequest {
  const url = new URL(opts.url);
  const amzDate = opts.amzDate ?? new Date().toISOString().replace(/[-:]|\\.\d{3}Z$/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const host = url.host;
  const allHeaders: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    ...(opts.headers ?? {}),
  };
  // Always include content-sha256 when a body is present.
  const body = opts.body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(body);
  if (opts.method === 'PUT' || opts.method === 'POST' || body.length > 0) {
    allHeaders['x-amz-content-sha256'] = payloadHash;
  }
  // Drop the unsigned x-amz-* helper headers from the canonical set except
  // x-amz-date and x-amz-content-sha256 (kept simple: sign everything).
  const { canonical, signed } = canonicalHeaders(allHeaders);

  const canonicalRequest = [
    opts.method,
    uriEncode(url.pathname),
    canonicalQuery(url),
    canonical,
    '',
    signed,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(Buffer.from(`AWS4${opts.secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    headers: {
      ...allHeaders,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signed}, Signature=${signature}`,
    },
    amzDate,
  };
}
