/**
 * @mbsks/openrtc-server — service wiring.
 *
 * `Services` bundles everything the HTTP + WS hosting layers need:
 * the `Store`, an optional `RecordingStorage`, and an optional `Relay`
 * (the in-process WebSocket hub from `ws.ts`). It is a plain object — the
 * hosting layer decides which pieces to attach.
 */

import type { Envelope } from '@mbsks/openrtc-protocol';
import type { RecordingStorage } from './recording.ts';
import type { Store } from './store.ts';

/**
 * HMAC auth configuration. When present (`secret` set), room-scoped routes
 * require a token issued by `issueToken` / `POST /auth/token`:
 *
 *  - REST: `Authorization: Bearer <token>` on join/leave/signal/state/
 *    recordings (+ close/delete for admins);
 *  - WS: `?token=<token>` on the `/ws?roomId=...` upgrade URL.
 *
 * When absent, the server runs in **legacy open mode** (any client can join
 * any room) — dev-only, see the README auth section.
 */
export interface AuthConfig {
  /** HMAC-SHA256 signing key. Never ship this to clients. */
  secret: string;
  /** Optional previous secrets for key rotation (tries each). */
  previousSecrets?: string[];
  /**
   * Optional shared secret for `POST /auth/token`. When set, token issuance
   * requires an `adminToken` header; `role: 'admin'` always requires it.
   * When unset, the token endpoint is open (participant tokens only).
   */
  adminToken?: string;
  /** Lifetime for tokens minted by `/auth/token` without an explicit `exp`; default 1 hour. */
  defaultTokenTtlMs?: number;
}

/** Broadcast a relayed envelope to connected WebSocket clients. */
export interface Relay {
  /**
   * Deliver `envelope` to WS clients subscribed to `roomId`.
   * `exceptSenderId` skips the sender's own connection(s) (the core
   * already excludes the sender from `offer`/`answer`/`ice` recipients).
   */
  broadcast(roomId: string, envelope: Envelope, opts?: { exceptSenderId?: string }): void;
  /** Number of connected clients for a room (diagnostics/tests). */
  clientCount(roomId: string): number;
}

/** TURN configuration (coturn REST API). */
export interface TurnConfig {
  secret: string;
  urls: string[];
  ttlSec?: number;
}

/** E2EE configuration (SFU + recording). */
export interface E2eeConfig {
  required?: boolean;
}

export interface Services {
  store: Store;
  /** Optional recording byte storage; without it, recording routes 501. */
  recordingStorage?: RecordingStorage;
  /** Optional WS relay hub; when present, HTTP mutations fan out to sockets. */
  relay?: Relay;
  /** Clock override (tests). */
  now?: () => number;
  /** Optional HMAC auth; when set, room routes require tokens (see AuthConfig). */
  auth?: AuthConfig;
  /** Optional TURN config; when set, GET /turn/credentials is live. */
  turn?: TurnConfig;
  /** Optional E2EE policy; when required, unencrypted tracks + recording egress are blocked. */
  e2ee?: E2eeConfig;
}

/** Build a `Services` object (convenience factory). */
export function createServices(partial: {
  store: Store;
  recordingStorage?: RecordingStorage;
  relay?: Relay;
  now?: () => number;
  auth?: AuthConfig;
  turn?: TurnConfig;
  e2ee?: E2eeConfig;
}): Services {
  return { ...partial };
}
