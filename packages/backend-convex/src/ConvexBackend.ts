/**
 * ConvexBackend — vidcall signaling adapter for Convex.
 *
 * Pattern (research doc §3): model the room as rows in `signals` and
 * `presence` tables; clients write with **mutations** (serialized,
 * transactional, strongly ordered) and read with **live queries**
 * (subscriptions push new results whenever the underlying rows change).
 *
 *  - `emit` -> `signals:send` mutation (stores the JSON frame in a row);
 *  - `onMessage` -> `signals:list` subscription, diffed by `_id` (Convex
 *    pushes the FULL result set on every change — the adapter must diff);
 *  - presence -> `presence:upsert` heartbeat mutation + `presence:list`
 *    subscription + stale sweep (Convex has no native presence).
 *
 * Ordering is `guaranteed`: mutations are serialized and transactions are
 * strongly consistent, so SDP offer/answer arrive in order. The 16 MiB
 * function-arg cap means no chunking is ever needed for signaling.
 *
 * The server-side functions/schema live in the package's `convex/` directory
 * — copy them into your Convex project (`convex/schema.ts`, `signals.ts`,
 * `presence.ts`) or use them as reference.
 */
import type { Envelope, PresenceState } from '@vidcall/protocol';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import { BaseSignalingTransport, type BaseOptions, type ParticipantInfo, type ParticipantPresence } from '@vidcall/transport';

/** Name of the mutation that appends one frame (from convex/signals.ts). */
export const SIGNALS_SEND_MUTATION = 'signals:send';
export const SIGNALS_LIST_QUERY = 'signals:list';
export const PRESENCE_UPSERT_MUTATION = 'presence:upsert';
export const PRESENCE_REMOVE_MUTATION = 'presence:remove';
export const PRESENCE_LIST_QUERY = 'presence:list';

/** Structural FunctionReferences for the reference functions in convex/ — the
 * adapter uses string names so it works with any deployment of the functions. */
const signalsSendRef = { _name: SIGNALS_SEND_MUTATION, _type: 'mutation' } as unknown as FunctionReference<'mutation'>;
const signalsListRef = { _name: SIGNALS_LIST_QUERY, _type: 'query' } as unknown as FunctionReference<'query'>;
const presenceUpsertRef = { _name: PRESENCE_UPSERT_MUTATION, _type: 'mutation' } as unknown as FunctionReference<'mutation'>;
const presenceRemoveRef = { _name: PRESENCE_REMOVE_MUTATION, _type: 'mutation' } as unknown as FunctionReference<'mutation'>;
const presenceListRef = { _name: PRESENCE_LIST_QUERY, _type: 'query' } as unknown as FunctionReference<'query'>;

export interface ConvexBackendOptions extends BaseOptions {
  /** Convex client (from `convex/browser`) — or provide `url` and the adapter owns one. */
  convex?: ConvexClient;
  url?: string;
  /** presence stale timeout ms. Default 15_000. */
  presenceTimeoutMs?: number;
}

interface SignalRow {
  _id: string;
  roomId: string;
  frame: string;
}

interface PresenceRow {
  _id: string;
  roomId: string;
  userId: string;
  state: PresenceState;
  metadata?: Record<string, unknown>;
  lastSeen: number;
}

export class ConvexBackend extends BaseSignalingTransport {
  readonly name = 'convex';
  readonly ordering = 'guaranteed' as const; // serialized mutations
  readonly maxPayloadBytes = 16 * 1024 * 1024;

  private client: ConvexClient | null = null;
  private readonly ownsClient: boolean;
  private readonly url: string | null = null;
  private unsubSignals: (() => void) | null = null;
  private unsubPresence: (() => void) | null = null;
  private readonly seenSignalIds = new Set<string>();
  private readonly seenPresence = new Map<string, PresenceRow>();

  constructor(opts: ConvexBackendOptions) {
    super(
      {
        doJoin: () => this.doJoin(),
        doLeave: () => this.doLeave(),
        doSendFrame: (frame) => this.doSendFrame(frame),
        doSetPresence: (state, metadata) => this.doSetPresence(state, metadata),
        doDispose: async () => this.doDispose(),
      },
      { ...opts, presenceTimeoutMs: opts.presenceTimeoutMs ?? 15_000 },
    );
    if (opts.convex) {
      this.client = opts.convex;
      this.ownsClient = false;
    } else if (opts.url) {
      // dynamic import keeps the heavy CLI out of the bundle when the client is injected
      this.url = opts.url;
      this.ownsClient = true;
    } else {
      throw new Error('convex: provide either convex client or url');
    }
  }

  /** Lazily create the owned client (async import of convex/browser). */
  private async ensureClient(): Promise<ConvexClient> {
    if (this.client) return this.client;
    const mod = await import('convex/browser');
    const ConvexClientCtor = mod.ConvexClient as unknown as new (url: string) => ConvexClient;
    this.client = new ConvexClientCtor(this.url!);
    return this.client;
  }

  // ------------------------------------------------------------- SDK hooks
  private async doJoin(): Promise<void> {
    const room = this.currentRoom;
    if (room === null) return;
    this.seenSignalIds.clear();
    this.seenPresence.clear();
    const client = await this.ensureClient();

    this.unsubSignals = client.onUpdate(signalsListRef, { roomId: room }, (signals) => {
      this.handleSignals(room, signals as unknown as SignalRow[]);
    });
    this.unsubPresence = client.onUpdate(presenceListRef, { roomId: room }, (rows) => {
      this.handlePresenceRows(room, rows as unknown as PresenceRow[]);
    });
  }

  private async doLeave(): Promise<void> {
    this.unsubSignals?.();
    this.unsubSignals = null;
    this.unsubPresence?.();
    this.unsubPresence = null;
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room !== null && selfId !== undefined && this.client) {
      await this.client.mutation(presenceRemoveRef, { roomId: room, userId: selfId }).catch(() => undefined);
    }
  }

  private async doSendFrame(frame: unknown): Promise<void> {
    const room = this.currentRoom;
    if (room === null) throw new Error('convex: not joined');
    const client = await this.ensureClient();
    await client.mutation(signalsSendRef, { roomId: room, frame: JSON.stringify(frame) });
  }

  private async doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) return;
    const client = await this.ensureClient();
    await client.mutation(presenceUpsertRef, {
      roomId: room,
      userId: selfId,
      state,
      metadata,
      lastSeen: Date.now(),
    });
  }

  private async doDispose(): Promise<void> {
    this.unsubSignals?.();
    this.unsubSignals = null;
    this.unsubPresence?.();
    this.unsubPresence = null;
    if (this.ownsClient && this.client) {
      await this.client.close().catch(() => undefined);
    }
  }

  // --------------------------------------------------------------- query diffs
  private handleSignals(room: string, signals: SignalRow[]): void {
    // Convex pushes the full set; deliver only frames we have not seen.
    // Sort by _id (Convex ids sort by insertion time) to preserve order.
    const sorted = [...signals].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    for (const row of sorted) {
      if (this.seenSignalIds.has(row._id)) continue;
      this.seenSignalIds.add(row._id);
      if (this.seenSignalIds.size > 4096) {
        // bound memory: drop the oldest seen ids (room streams are short-lived)
        const oldest = [...this.seenSignalIds].slice(0, 1024);
        for (const id of oldest) this.seenSignalIds.delete(id);
      }
      try {
        this.deliverFrame(JSON.parse(row.frame) as unknown);
      } catch {
        // malformed frame — skip
      }
    }
  }

  private handlePresenceRows(room: string, rows: PresenceRow[]): void {
    const current = new Map<string, PresenceRow>();
    for (const row of rows) {
      current.set(row.userId, row);
      const prev = this.seenPresence.get(row.userId);
      if (!prev || prev.state !== row.state || prev.lastSeen !== row.lastSeen) {
        this.touchPresence(row.userId);
        this.deliverPresence({ participantId: row.userId, state: row.state, metadata: row.metadata });
      }
    }
    // rows that disappeared = peers removed
    for (const [userId, prev] of this.seenPresence) {
      if (!current.has(userId)) {
        this.deliverPresence({ participantId: userId, state: 'offline', metadata: prev.metadata });
      }
    }
    this.seenPresence.clear();
    for (const [userId, row] of current) this.seenPresence.set(userId, row);
  }
}
