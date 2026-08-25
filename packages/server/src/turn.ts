/**
 * @mbsks/server — TURN credentials (RFC 5389 TURN REST API, coturn).
 *
 * Short-lived `turn:` / `turns:` credentials without a DB: the server holds a
 * single HMAC key (`turn.secret`) and a set of URLs (`turn.urls`).  Clients
 * fetch `GET /turn/credentials` (bearer token required) and receive an
 * `RTCIceServer` whose `username` is `expiry:participantId` and whose
 * `credential` is `HMAC-SHA1(username, secret)` (base64).  Coturn derives the
 * same credential from its `static-auth-secret` and enforces expiry without
 * any DB lookup.
 *
 * Docs: https://github.com/coturn/coturn/wiki/Turn-REST-API
 * Coturn config: `use-auth-secret`, `static-auth-secret=<secret>`,
 *   `realm=<turn urls host>`.
 */

import { createHmac } from 'node:crypto';

export interface TurnConfig {
  /** HMAC-SHA1 signing key (coturn `static-auth-secret`). Never ship to clients. */
  secret: string;
  /** `turn:` / `turns:` URLs to return alongside the ephemeral credential. */
  urls: string[];
  /** Credential lifetime in seconds (default 86400 = 24h). */
  ttlSec?: number;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

/**
 * Mint one coturn-compatible credential for `participantId`.
 * `nowSec` defaults to `Date.now()/1000` (epoch seconds).
 */
export function issueTurnCredentials(
  config: TurnConfig,
  participantId: string,
  nowSec = Math.floor(Date.now() / 1000),
): TurnCredentials {
  if (!config.secret || typeof config.secret !== 'string') {
    throw new TypeError('turn.secret must be a non-empty string');
  }
  if (!Array.isArray(config.urls) || config.urls.length === 0) {
    throw new TypeError('turn.urls must be a non-empty array');
  }
  if (typeof participantId !== 'string' || participantId.length === 0) {
    throw new TypeError('participantId must be a non-empty string');
  }
  const ttl = config.ttlSec ?? 86400;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new TypeError('turn.ttlSec must be a positive number');
  }
  const expiry = nowSec + ttl;
  const username = `${expiry}:${participantId}`;
  const credential = createHmac('sha1', config.secret).update(username, 'utf8').digest('base64');
  return { urls: config.urls, username, credential };
}

/** Map credentials to the WebRTC `RTCIceServer` shape. */
export function toIceServers(creds: TurnCredentials): RTCIceServer[] {
  return [{ urls: creds.urls, username: creds.username, credential: creds.credential }];
}
