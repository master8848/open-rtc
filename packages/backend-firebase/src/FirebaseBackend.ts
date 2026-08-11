/**
 * FirebaseBackend — vidcall signaling adapter for Firebase Realtime Database.
 *
 * Pattern (research doc §8): each room owns two paths:
 *
 *   rooms/{room}/signals/{pushId}   -> { senderId, frame }  (signal log)
 *   presence/{room}/{userId}        -> { state, metadata, lastSeen }
 *
 *  - `emit`   -> `push()` onto the signal log; the far side receives it via
 *    `onChildAdded` (RTDB pushes ONLY new children — natural diffing);
 *  - presence -> heartbeat writes + **native `onDisconnect()`** hooks that the
 *    RTDB server executes on any disconnect (clean close or crash) — the
 *    canonical Firebase presence system;
 *  - own writes are echoed back through the same path — the adapter filters
 *    them by senderId.
 *
 * Ordering is `guaranteed` for sequential writes to a path; push keys sort
 * chronologically, so SDP offer/answer arrive in order. The 16 MB SDK write
 * cap makes chunking unnecessary for signaling.
 */
import type { Envelope, PresenceState } from '@vidcall/protocol';
import type { FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  off,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  set,
  update,
  type Database,
  type DataSnapshot,
  type OnDisconnect,
  type Unsubscribe,
} from 'firebase/database';
import { BaseSignalingTransport, type BaseOptions, type ParticipantInfo, type ParticipantPresence } from '@vidcall/transport';

export interface FirebaseBackendOptions extends BaseOptions {
  /** RTDB instance — or provide `app` and the adapter gets one via getDatabase(). */
  database?: Database;
  app?: FirebaseApp;
  /** presence stale timeout ms (safety net under native onDisconnect). Default 30_000. */
  presenceTimeoutMs?: number;
}

interface SignalChild {
  senderId: string;
  frame: string;
}

interface PresenceRow {
  state: PresenceState;
  metadata?: Record<string, unknown> | null;
  lastSeen: number;
}

export class FirebaseBackend extends BaseSignalingTransport {
  readonly name = 'firebase';
  readonly ordering = 'guaranteed' as const; // per-path sequential write ordering
  readonly maxPayloadBytes = 16 * 1024 * 1024; // SDK single-write cap

  private readonly db: Database;
  private signalsRef: ReturnType<typeof ref> | null = null;
  private presenceRef: ReturnType<typeof ref> | null = null;
  private selfPresenceRef: ReturnType<typeof ref> | null = null;
  private disconnectHook: OnDisconnect | null = null;
  private unsubSignals: Unsubscribe | null = null;
  private unsubPresence: Unsubscribe | null = null;
  private readonly seenPresence = new Map<string, PresenceRow>();

  constructor(opts: FirebaseBackendOptions) {
    super(
      {
        doJoin: () => this.doJoin(),
        doLeave: () => this.doLeave(),
        doSendFrame: (frame) => this.doSendFrame(frame),
        doSetPresence: (state, metadata) => this.doSetPresence(state, metadata),
        doDispose: async () => this.doDispose(),
      },
      {
        ...opts,
        heartbeatMs: opts.heartbeatMs ?? 10_000, // presence is native; heartbeat only refreshes lastSeen + re-arms onDisconnect
        presenceTimeoutMs: opts.presenceTimeoutMs ?? 30_000,
      },
    );
    if (opts.database) {
      this.db = opts.database;
    } else if (opts.app) {
      this.db = getDatabase(opts.app);
    } else {
      throw new Error('firebase: provide either database or app');
    }
  }

  // ------------------------------------------------------------- SDK hooks
  private async doJoin(): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) return;
    this.seenPresence.clear();

    this.signalsRef = ref(this.db, `rooms/${room}/signals`);
    this.presenceRef = ref(this.db, `presence/${room}`);
    this.selfPresenceRef = ref(this.db, `presence/${room}/${selfId}`);

    // own presence row + server-side disconnect hook (native presence)
    await set(this.selfPresenceRef, { state: 'online', lastSeen: Date.now() });
    this.armDisconnectHook();

    this.unsubSignals = onChildAdded(this.signalsRef, (snap) => this.onSignalChild(snap));
    this.unsubPresence = onValue(this.presenceRef, (snap) => this.onPresenceValue(snap));
  }

  private async doLeave(): Promise<void> {
    this.unsubSignals?.();
    this.unsubSignals = null;
    this.unsubPresence?.();
    this.unsubPresence = null;
    await this.disconnectHook?.cancel().catch(() => undefined);
    this.disconnectHook = null;
    if (this.signalsRef) off(this.signalsRef);
    if (this.presenceRef) off(this.presenceRef);
    if (this.selfPresenceRef) {
      await remove(this.selfPresenceRef).catch(() => undefined);
    }
  }

  private async doSendFrame(frame: unknown): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) throw new Error('firebase: not joined');
    await push(this.signalsRef!, { senderId: selfId, frame: JSON.stringify(frame) });
  }

  private async doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    if (this.selfPresenceRef === null) return;
    await update(this.selfPresenceRef, { state, metadata: metadata ?? null, lastSeen: Date.now() });
    this.armDisconnectHook(); // re-arm: the server executes the hook at most once
  }

  private async doDispose(): Promise<void> {
    this.unsubSignals?.();
    this.unsubSignals = null;
    this.unsubPresence?.();
    this.unsubPresence = null;
    if (this.signalsRef) off(this.signalsRef);
    if (this.presenceRef) off(this.presenceRef);
    this.disconnectHook?.cancel().catch(() => undefined);
    this.disconnectHook = null;
  }

  // --------------------------------------------------------------- listeners
  private armDisconnectHook(): void {
    if (this.selfPresenceRef === null) return;
    // keep metadata; only flip state + lastSeen on disconnect
    this.disconnectHook = onDisconnect(this.selfPresenceRef);
    this.disconnectHook.update({ state: 'offline', lastSeen: Date.now() });
  }

  private onSignalChild(snap: DataSnapshot): void {
    const v = snap.val() as SignalChild | null;
    if (!v || typeof v !== 'object' || typeof v.frame !== 'string') return;
    if (v.senderId === this.self?.id) return; // own echo
    try {
      this.deliverFrame(JSON.parse(v.frame) as unknown);
    } catch {
      // malformed frame — skip
    }
  }

  private onPresenceValue(snap: DataSnapshot): void {
    const rows = (snap.val() as Record<string, PresenceRow> | null) ?? {};
    const current = new Map<string, PresenceRow>();
    for (const [userId, row] of Object.entries(rows)) {
      if (userId === this.self?.id) continue; // never report ourselves
      current.set(userId, row);
      const prev = this.seenPresence.get(userId);
      if (!prev || prev.state !== row.state || prev.lastSeen !== row.lastSeen || JSON.stringify(prev.metadata) !== JSON.stringify(row.metadata)) {
        this.touchPresence(userId);
        this.deliverPresence({ participantId: userId, state: row.state, metadata: row.metadata ?? undefined });
      }
    }
    // rows that disappeared (remove on leave/cleanup) -> offline
    for (const [userId, prev] of this.seenPresence) {
      if (!current.has(userId)) {
        this.deliverPresence({ participantId: userId, state: 'offline', metadata: prev.metadata ?? undefined });
      }
    }
    this.seenPresence.clear();
    for (const [userId, row] of current) this.seenPresence.set(userId, row);
  }
}
