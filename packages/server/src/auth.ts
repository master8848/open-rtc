/**
 * @vidcall/server — HMAC-signed room tokens.
 *
 * Zero-dependency auth (node:crypto only): compact JWT-style tokens
 * (`header.payload.signature`, base64url, HS256) that bind a caller to one
 * room and one participant identity:
 *
 *  - `issueToken(secret, { roomId, participantId, role, exp })` mints a token
 *    for your host app / the `POST /auth/token` endpoint.
 *  - `verifyToken(secret, token)` validates signature + expiry and returns
 *    the claims — or throws `AuthError` (401/403), which the HTTP layer maps
 *    to the standard `{ error: { code, message } }` envelope.
 *
 * Room-scoped: a token minted for room X cannot join, signal in, or read
 * room Y (the guard layers in `http.ts` / `ws.ts` enforce the match).
 * Roles: `'participant'` (join/signal/state/recordings for their room) and
 * `'admin'` (additionally close/delete rooms and read any room state).
 *
 * Timestamps follow the JWT convention: **epoch seconds**.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { VidcallError } from './errors.ts';

/** Who the token holder is allowed to act as. */
export type TokenRole = 'participant' | 'admin';

/** Fine-grained capability flags (orthogonal to `role`). */
export interface TokenCaps {
  publish?: boolean;
  subscribe?: boolean;
  record?: boolean;
  moderate?: boolean;
}

/** Verified token claims (epoch seconds for `iat`/`exp`, JWT convention). */
export interface TokenClaims {
  /** The only room this token grants access to. */
  roomId: string;
  /** The participant identity the token is bound to (enforced by guards). */
  participantId: string;
  role: TokenRole;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Optional JWT ID for revocation. */
  jti?: string;
  /** Fine-grained capabilities (least privilege). */
  caps?: TokenCaps;
  /** Holder asserts E2EE capability (used when `e2eeRequired` is set). */
  e2ee?: boolean;
}

export interface IssueTokenOptions {
  roomId: string;
  participantId: string;
  /** Default `'participant'`. */
  role?: TokenRole;
  /** Expiry, epoch seconds. Defaults to `now + DEFAULT_TOKEN_TTL_SECONDS`. */
  exp?: number;
  /** Clock override (tests); epoch ms. */
  now?: number;
  /** Optional JWT ID (revocation). Auto-generated when omitted and revocation is desired. */
  jti?: string;
  /** Fine-grained capabilities. */
  caps?: TokenCaps;
  /** E2EE capability flag. */
  e2ee?: boolean;
}

/** Default token lifetime when `exp` is omitted (1 hour). */
export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;

/** Auth failures: `unauthorized`/`token_expired` → 401, `forbidden` → 403. */
export type AuthErrorCode = 'unauthorized' | 'token_expired' | 'forbidden';

/**
 * Thrown by `verifyToken` (and used by the HTTP/WS guards) for missing,
 * malformed, expired, or insufficient tokens. Extends `VidcallError` so the
 * shared `dispatch()` error mapping produces the standard JSON envelope.
 */
export class AuthError extends VidcallError {
  override readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(code, message, code === 'forbidden' ? 403 : 401);
    this.name = 'AuthError';
    this.code = code;
  }
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

/** Constant-time string comparison (length leak is acceptable: hashes). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Mint a compact JWT-style token: `base64url(header).base64url(payload)`
 * signed with HMAC-SHA256 (HS256). The token is room- AND identity-scoped:
 * guards reject it for any other `roomId` or `participantId`.
 *
 * @returns the compact token string (`header.payload.signature`).
 */
export function issueToken(secret: string, opts: IssueTokenOptions): string {
  const secretKey = requireString(secret, 'secret');
  const roomId = requireString(opts.roomId, 'roomId');
  const participantId = requireString(opts.participantId, 'participantId');
  const role: TokenRole = opts.role ?? 'participant';
  if (role !== 'participant' && role !== 'admin') {
    throw new TypeError('role must be "participant" or "admin"');
  }
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const exp = opts.exp ?? nowSec + DEFAULT_TOKEN_TTL_SECONDS;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new TypeError('exp must be a finite number (epoch seconds)');
  }
  if (opts.jti !== undefined && (typeof opts.jti !== 'string' || opts.jti.length === 0)) {
    throw new TypeError('jti must be a non-empty string when provided');
  }
  if (opts.caps !== undefined) validateCaps(opts.caps);
  if (opts.e2ee !== undefined && typeof opts.e2ee !== 'boolean') {
    throw new TypeError('e2ee must be a boolean when provided');
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = { roomId, participantId, role, exp, iat: nowSec };
  if (opts.jti) payload.jti = opts.jti;
  if (opts.caps) payload.caps = opts.caps;
  if (opts.e2ee !== undefined) payload.e2ee = opts.e2ee;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${hmac(signingInput, secretKey)}`;
}

/**
 * Validate a token: format, algorithm, HMAC signature (constant-time), and
 * expiry. Returns the claims on success.
 *
 * @throws {AuthError} `unauthorized` (malformed/tampered/unsupported),
 *   `token_expired` (exp <= now).
 */
export function verifyToken(secret: string, token: string): TokenClaims {
  const secretKey = requireString(secret, 'secret');
  if (typeof token !== 'string' || token.length === 0) {
    throw new AuthError('unauthorized', 'Missing or empty token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError('unauthorized', 'Malformed token: expected header.payload.signature');
  }
  const [h, p, sig] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(b64urlDecode(h));
    payload = JSON.parse(b64urlDecode(p));
  } catch {
    throw new AuthError('unauthorized', 'Malformed token: invalid base64url or JSON');
  }

  const hdr = header as Record<string, unknown>;
  if (hdr.alg !== 'HS256') {
    throw new AuthError('unauthorized', `Unsupported token algorithm: ${String(hdr.alg)}`);
  }
  const expectedSig = hmac(`${h}.${p}`, secretKey);
  if (!safeEqual(expectedSig, sig)) {
    throw new AuthError('unauthorized', 'Token signature verification failed (tampered token?)');
  }

  const claims = payload as Record<string, unknown>;
  if (typeof claims.roomId !== 'string' || claims.roomId.length === 0) {
    throw new AuthError('unauthorized', 'Malformed token: missing roomId');
  }
  if (typeof claims.participantId !== 'string' || claims.participantId.length === 0) {
    throw new AuthError('unauthorized', 'Malformed token: missing participantId');
  }
  if (claims.role !== 'participant' && claims.role !== 'admin') {
    throw new AuthError('unauthorized', 'Malformed token: role must be "participant" or "admin"');
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new AuthError('unauthorized', 'Malformed token: invalid exp');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp <= nowSec) {
    throw new AuthError(
      'token_expired',
      `Token expired at ${new Date(claims.exp * 1000).toISOString()}`,
    );
  }

  // Optional claims (backwards compatible, validated when present).
  let jti: string | undefined;
  if (claims.jti !== undefined) {
    if (typeof claims.jti !== 'string' || claims.jti.length === 0) {
      throw new AuthError('unauthorized', 'Malformed token: invalid jti');
    }
    jti = claims.jti;
  }
  let caps: TokenCaps | undefined;
  if (claims.caps !== undefined) {
    if (typeof claims.caps !== 'object' || claims.caps === null || Array.isArray(claims.caps)) {
      throw new AuthError('unauthorized', 'Malformed token: invalid caps');
    }
    validateCaps(claims.caps as Record<string, unknown>);
    caps = claims.caps as TokenCaps;
  }
  let e2ee: boolean | undefined;
  if (claims.e2ee !== undefined) {
    if (typeof claims.e2ee !== 'boolean') {
      throw new AuthError('unauthorized', 'Malformed token: invalid e2ee');
    }
    e2ee = claims.e2ee;
  }

  const out: TokenClaims = {
    roomId: claims.roomId,
    participantId: claims.participantId,
    role: claims.role as TokenRole,
    exp: claims.exp,
    iat: typeof claims.iat === 'number' ? claims.iat : nowSec,
  };
  if (jti !== undefined) out.jti = jti;
  if (caps !== undefined) out.caps = caps;
  if (e2ee !== undefined) out.e2ee = e2ee;
  // Revocation check: when a jti is present and this token was revoked, treat as expired.
  if (out.jti && isRevoked(out.jti)) {
    throw new AuthError('token_expired', `Token revoked (jti=${out.jti})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caps validation helper (shared issuer/verifier)
// ---------------------------------------------------------------------------

function validateCaps(caps: unknown): void {
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    throw new TypeError('caps must be an object');
  }
  const allowed = new Set(['publish', 'subscribe', 'record', 'moderate']);
  for (const [k, v] of Object.entries(caps as Record<string, unknown>)) {
    if (!allowed.has(k)) throw new TypeError(`caps: unknown key '${k}'`);
    if (v !== undefined && typeof v !== 'boolean') {
      throw new TypeError(`caps.${k} must be a boolean`);
    }
  }
}

// ---------------------------------------------------------------------------
// Rotation + revocation (in-memory for v1; can move to Redis)
// ---------------------------------------------------------------------------

/** Try each secret (current first) until one verifies; otherwise throw the last error. */
export function verifyTokenWithRotation(
  secrets: readonly string[],
  token: string,
): TokenClaims {
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new TypeError('secrets must be a non-empty array');
  }
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return verifyToken(secret, token);
    } catch (err) {
      lastErr = err;
      // Keep the strongest signal: token_expired / forbidden win over unauthorized.
      if (err instanceof AuthError && err.code === 'token_expired') {
        // Still try other secrets for token_expired: a rotation should not hide revocation.
        continue;
      }
      if (err instanceof AuthError && err.code === 'forbidden') throw err;
      // unauthorized (bad sig) — try next secret
    }
  }
  throw lastErr instanceof Error ? lastErr : new AuthError('unauthorized', 'Token verification failed');
}

const revoked = new Map<string, number>(); // jti -> expSec

/** Revoke a token by its `jti` (in-memory; caller should pass `exp` for TTL). */
export function revokeToken(jti: string, expSec?: number): void {
  if (typeof jti !== 'string' || jti.length === 0) throw new TypeError('jti must be a non-empty string');
  const ttl = expSec ?? Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;
  revoked.set(jti, ttl);
}

export function isRevoked(jti: string): boolean {
  const exp = revoked.get(jti);
  if (exp === undefined) return false;
  if (exp <= Math.floor(Date.now() / 1000)) {
    revoked.delete(jti);
    return false;
  }
  return true;
}

/** For tests: clear the revocation set. */
export function clearRevocations(): void {
  revoked.clear();
}

/** Create a token endpoint helper for callers that want to manage issuance inline. */
export function createTokenIssuer(secret: string) {
  return (opts: IssueTokenOptions) => issueToken(secret, opts);
}
