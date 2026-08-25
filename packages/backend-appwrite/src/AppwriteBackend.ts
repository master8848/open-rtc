/**
 * AppwriteBackend — vidcall signaling adapter for Appwrite Realtime.
 *
 * Pattern (research doc §7): Appwrite realtime is **server -> client only**
 * (no client-to-client broadcast, no native presence), so the adapter models
 * signaling as document events:
 *
 *   signals  collection:  { roomId, senderId, frame }  — one doc per frame
 *   presence collection:  { roomId, userId, state, metadata, lastSeen } — one
 *                          heartbeat doc per peer (upserted, deleted on leave)
 *
 *  - `emit` -> `createDocument` on the signals collection; the event callback
 *    fires for every new doc in the collection (filtered by roomId, deduped
 *    by $id — Appwrite echoes your own writes back);
 *  - presence -> heartbeat-document pattern (upsert every beat) + stale sweep;
 *    a late joiner snapshots the presence collection via listDocuments;
 *  - ICE is coalesced by default (realtime messages are metered — billing!).
 *
 * Ordering: per-document commit order is sequential per writer; cross-writer
 * interleaving needs the seq reorder buffer (`seq-required`).
 */
import type { Envelope, PresenceState } from '@mbsks/protocol';
import { ID, Query, type Client, type Models, type RealtimeResponseEvent } from 'appwrite';
import type { Databases } from 'appwrite';
import type { Realtime, RealtimeSubscription } from 'appwrite';
import { BaseSignalingTransport, type BaseOptions, type ParticipantInfo, type ParticipantPresence } from '@mbsks/transport';

/** Free-tier realtime message cap (Pro: 3 MB) — chunking kicks in above this. */
export const APPWRITE_MAX_PAYLOAD = 256 * 1024;

export interface AppwriteBackendOptions extends BaseOptions {
  /** Databases + Realtime services (from `new Databases(client)` / `new Realtime(client)`). */
  databases?: Databases;
  realtime?: Realtime;
  /** An Appwrite Client — the adapter creates Databases/Realtime from it (and disconnects realtime on dispose). */
  client?: Client;
  databaseId: string;
  /** collection names (create them with attributes: roomId:string, senderId:string, frame:string, ...). */
  signalsCollectionId?: string;
  presenceCollectionId?: string;
  /** presence stale timeout ms. Default 15_000. */
  presenceTimeoutMs?: number;
  /** ICE coalescing window ms (default 100 — realtime messages are billed). */
  coalesceIceMs?: number;
}

interface SignalDoc extends Models.Document {
  roomId: string;
  senderId: string;
  frame: string;
}

interface PresenceDoc extends Models.Document {
  roomId: string;
  userId: string;
  state: PresenceState;
  metadata?: Record<string, unknown> | null;
  lastSeen: number;
}

export class AppwriteBackend extends BaseSignalingTransport {
  readonly name = 'appwrite';
  readonly ordering = 'seq-required' as const;
  readonly maxPayloadBytes = APPWRITE_MAX_PAYLOAD;

  private databases: Databases | null = null;
  private realtime: Realtime | null = null;
  private readonly ownsServices: boolean;
  private readonly client: Client | null = null;
  private readonly databaseId: string;
  private readonly signalsCol: string;
  private readonly presenceCol: string;

  private signalsChannel = '';
  private presenceChannel = '';
  private signalsSub: RealtimeSubscription | null = null;
  private presenceSub: RealtimeSubscription | null = null;
  private ownPresenceDocId: string | null = null;
  private readonly seenSignalIds = new Set<string>();
  private readonly seenPresence = new Map<string, { userId: string; state: PresenceState; metadata?: Record<string, unknown> | null; lastSeen: number }>();
  private readonly presenceDocUser = new Map<string, string>(); // doc $id -> userId

  constructor(opts: AppwriteBackendOptions) {
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
        presenceTimeoutMs: opts.presenceTimeoutMs ?? 15_000,
        coalesceIceMs: opts.coalesceIceMs ?? 100, // realtime messages are metered
      },
    );
    this.databaseId = opts.databaseId;
    this.signalsCol = opts.signalsCollectionId ?? 'signals';
    this.presenceCol = opts.presenceCollectionId ?? 'presence';
    if (opts.databases && opts.realtime) {
      this.databases = opts.databases;
      this.realtime = opts.realtime;
      this.ownsServices = false;
    } else if (opts.client) {
      this.client = opts.client;
      this.ownsServices = true;
    } else {
      throw new Error('appwrite: provide databases+realtime services or a client');
    }
  }

  /** Lazily create the services when a client was provided (keeps ESM clean). */
  private async ensureServices(): Promise<{ databases: Databases; realtime: Realtime }> {
    if (this.databases && this.realtime) return { databases: this.databases, realtime: this.realtime };
    const mod = await import('appwrite');
    const DatabasesCtor = mod.Databases as unknown as new (client: Client) => Databases;
    const RealtimeCtor = mod.Realtime as unknown as new (client: Client) => Realtime;
    this.databases = new DatabasesCtor(this.client!);
    this.realtime = new RealtimeCtor(this.client!);
    return { databases: this.databases, realtime: this.realtime };
  }

  // ------------------------------------------------------------- SDK hooks
  private async doJoin(): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) return;
    this.seenSignalIds.clear();
    this.seenPresence.clear();

    const { databases, realtime } = await this.ensureServices();
    this.signalsChannel = `databases.${this.databaseId}.collections.${this.signalsCol}.documents`;
    this.presenceChannel = `databases.${this.databaseId}.collections.${this.presenceCol}.documents`;

    this.signalsSub = await realtime.subscribe(this.signalsChannel, (event) => this.onRealtime(event as RealtimeResponseEvent<Models.Document>));
    this.presenceSub = await realtime.subscribe(this.presenceChannel, (event) => this.onRealtime(event as RealtimeResponseEvent<Models.Document>));

    // late joiner: snapshot current presence rows (realtime has no replay)
    const snapshot = await databases
      .listDocuments({ databaseId: this.databaseId, collectionId: this.presenceCol, queries: [Query.equal('roomId', room)] })
      .catch(() => null);
    if (snapshot) {
      for (const doc of snapshot.documents as unknown as PresenceDoc[]) {
        if (doc.userId === selfId) continue;
        this.touchPresence(doc.userId);
        this.deliverPresence({ participantId: doc.userId, state: doc.state, metadata: doc.metadata ?? undefined });
        this.seenPresence.set(doc.userId, { userId: doc.userId, state: doc.state, metadata: doc.metadata, lastSeen: doc.lastSeen });
      }
    }
  }

  private async doLeave(): Promise<void> {
    await this.signalsSub?.unsubscribe().catch(() => undefined);
    await this.presenceSub?.unsubscribe().catch(() => undefined);
    this.signalsSub = null;
    this.presenceSub = null;
    if (this.ownPresenceDocId) {
      const { databases } = await this.ensureServices();
      await databases
        .deleteDocument({ databaseId: this.databaseId, collectionId: this.presenceCol, documentId: this.ownPresenceDocId })
        .catch(() => undefined);
      this.ownPresenceDocId = null;
    }
  }

  private async doSendFrame(frame: unknown): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) throw new Error('appwrite: not joined');
    const { databases } = await this.ensureServices();
    await databases.createDocument({
      databaseId: this.databaseId,
      collectionId: this.signalsCol,
      documentId: ID.unique(),
      data: { roomId: room, senderId: selfId, frame: JSON.stringify(frame) },
    });
  }

  private async doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    const room = this.currentRoom;
    const selfId = this.self?.id;
    if (room === null || selfId === undefined) return;
    const { databases } = await this.ensureServices();
    const data = { roomId: room, userId: selfId, state, metadata: metadata ?? null, lastSeen: Date.now() };
    if (this.ownPresenceDocId) {
      await databases
        .updateDocument({ databaseId: this.databaseId, collectionId: this.presenceCol, documentId: this.ownPresenceDocId, data })
        .catch(async () => {
          // doc may have been deleted server-side — recreate
          this.ownPresenceDocId = null;
          await this.doSetPresence(state, metadata);
        });
    } else {
      // deterministic id: presence_{room}_{user} (<= 36 chars, [a-zA-Z0-9._-])
      const docId = `p_${sanitizeId(room)}_${sanitizeId(selfId)}`.slice(0, 36);
      const doc = await databases.createDocument({
        databaseId: this.databaseId,
        collectionId: this.presenceCol,
        documentId: docId,
        data,
      });
      this.ownPresenceDocId = (doc as { $id: string }).$id;
    }
  }

  private async doDispose(): Promise<void> {
    await this.signalsSub?.unsubscribe().catch(() => undefined);
    await this.presenceSub?.unsubscribe().catch(() => undefined);
    this.signalsSub = null;
    this.presenceSub = null;
    if (this.ownsServices && this.realtime) {
      await this.realtime.disconnect().catch(() => undefined);
    }
  }

  // --------------------------------------------------------------- realtime
  private onRealtime(event: RealtimeResponseEvent<Models.Document>): void {
    const doc = event.payload as SignalDoc & PresenceDoc;
    if (!doc || typeof doc !== 'object' || !doc.$collectionId) return;
    const room = this.currentRoom;
    if (room === null) return;
    const eventKind = event.events[0]?.split('.').pop();

    if (doc.$collectionId === this.signalsCol) {
      if (eventKind === 'create' && doc.roomId === room && doc.senderId !== this.self?.id) {
        if (this.seenSignalIds.has(doc.$id)) return;
        this.seenSignalIds.add(doc.$id);
        if (this.seenSignalIds.size > 4096) {
          const oldest = [...this.seenSignalIds].slice(0, 1024);
          for (const id of oldest) this.seenSignalIds.delete(id);
        }
        try {
          this.deliverFrame(JSON.parse(doc.frame) as unknown);
        } catch {
          // malformed frame — skip
        }
      }
      return;
    }

    if (doc.$collectionId === this.presenceCol) {
      if (eventKind === 'delete') {
        // Delete payloads may carry only $id (no roomId) — resolve via our map,
        // which is only populated for this room's docs, so this is safe.
        const userId = doc.userId || this.presenceDocUser.get(doc.$id);
        if (userId && userId !== this.self?.id) {
          const prev = this.seenPresence.get(userId);
          this.deliverPresence({ participantId: userId, state: 'offline', metadata: prev?.metadata ?? undefined });
          this.seenPresence.delete(userId);
        }
        this.presenceDocUser.delete(doc.$id);
        return;
      }
      if (doc.roomId !== room) return;
      if (doc.userId === this.self?.id) return; // own echo
      this.presenceDocUser.set(doc.$id, doc.userId);
      const prev = this.seenPresence.get(doc.userId);
      if (!prev || prev.state !== doc.state || prev.lastSeen !== doc.lastSeen || JSON.stringify(prev.metadata) !== JSON.stringify(doc.metadata)) {
        this.touchPresence(doc.userId);
        this.deliverPresence({ participantId: doc.userId, state: doc.state, metadata: doc.metadata ?? undefined });
      }
      this.seenPresence.set(doc.userId, { userId: doc.userId, state: doc.state, metadata: doc.metadata, lastSeen: doc.lastSeen });
    }
  }
}

/** Appwrite document IDs: <= 36 chars, [a-zA-Z0-9._-], must not start with a special char. */
function sanitizeId(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[^a-zA-Z0-9]+/, '');
  return clean === '' ? 'x' : clean;
}
