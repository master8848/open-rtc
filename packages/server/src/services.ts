/**
 * @vidcall/server — service wiring.
 *
 * `Services` bundles everything the HTTP + WS hosting layers need:
 * the `Store`, an optional `RecordingStorage`, and an optional `Relay`
 * (the in-process WebSocket hub from `ws.ts`). It is a plain object — the
 * hosting layer decides which pieces to attach.
 */

import type { Envelope } from '@vidcall/protocol';
import type { RecordingStorage } from './recording.ts';
import type { Store } from './store.ts';

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

export interface Services {
  store: Store;
  /** Optional recording byte storage; without it, recording routes 501. */
  recordingStorage?: RecordingStorage;
  /** Optional WS relay hub; when present, HTTP mutations fan out to sockets. */
  relay?: Relay;
  /** Clock override (tests). */
  now?: () => number;
}

/** Build a `Services` object (convenience factory). */
export function createServices(partial: {
  store: Store;
  recordingStorage?: RecordingStorage;
  relay?: Relay;
  now?: () => number;
}): Services {
  return { ...partial };
}
