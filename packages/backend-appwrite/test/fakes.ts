/**
 * In-memory Appwrite SDK fakes for unit tests: FakeDatabases + FakeRealtime
 * wired through a shared FakeAppwriteStore.
 *
 * Mirrors the SDK 26 API surface the adapter uses:
 *  - Databases.createDocument/updateDocument/deleteDocument/listDocuments
 *  - Realtime.subscribe(channel, cb) -> { unsubscribe() }
 *
 * Realtime semantics follow real Appwrite:
 *  - server -> client only: events fire when documents change;
 *  - a writer's OWN changes are delivered back to it (the adapter dedupes);
 *  - delete events carry only { $id, $collectionId } (no document data).
 */
import type { Models, RealtimeResponseEvent } from 'appwrite';

export type Doc = Record<string, unknown> & { $id: string; $collectionId: string; $databaseId: string; $createdAt: string; $updatedAt: string; $permissions: string[] };

let docCounter = 0;

export class FakeAppwriteStore {
  docs = new Map<string, Map<string, Doc>>();
  realtime = new FakeRealtime();

  collection(col: string): Map<string, Doc> {
    let m = this.docs.get(col);
    if (!m) {
      m = new Map();
      this.docs.set(col, m);
    }
    return m;
  }

  makeDoc(col: string, data: Record<string, unknown>): Doc {
    const now = new Date().toISOString();
    return {
      $id: data.$id ? String(data.$id) : `doc_${String(++docCounter).padStart(6, '0')}`,
      $collectionId: col,
      $databaseId: 'main',
      $createdAt: now,
      $updatedAt: now,
      $permissions: [],
      ...data,
    } as Doc;
  }
}

export class FakeDatabases {
  constructor(public readonly store: FakeAppwriteStore) {}

  async createDocument(params: { collectionId: string; documentId: string; data: Record<string, unknown> }): Promise<Doc> {
    const col = this.store.collection(params.collectionId);
    if (col.has(params.documentId)) throw Object.assign(new Error('Document with the requested ID already exists'), { code: 409 });
    const doc = this.store.makeDoc(params.collectionId, { ...params.data, $id: params.documentId });
    col.set(doc.$id, doc);
    this.store.realtime.emit(params.collectionId, doc, 'create');
    return doc;
  }

  async updateDocument(params: { collectionId: string; documentId: string; data: Record<string, unknown> }): Promise<Doc> {
    const col = this.store.collection(params.collectionId);
    const prev = col.get(params.documentId);
    if (!prev) throw new Error('Document not found');
    const doc: Doc = { ...prev, ...params.data, $id: prev.$id, $updatedAt: new Date().toISOString() };
    col.set(doc.$id, doc);
    this.store.realtime.emit(params.collectionId, doc, 'update');
    return doc;
  }

  async deleteDocument(params: { collectionId: string; documentId: string }): Promise<Record<string, never>> {
    const col = this.store.collection(params.collectionId);
    if (!col.delete(params.documentId)) throw new Error('Document not found');
    // like real Appwrite realtime: delete events carry only identity fields
    this.store.realtime.emit(params.collectionId, { $id: params.documentId, $collectionId: params.collectionId } as Doc, 'delete');
    return {};
  }

  async listDocuments(params: { collectionId: string; queries?: string[] }): Promise<{ total: number; documents: Doc[] }> {
    const col = this.store.collection(params.collectionId);
    let docs = [...col.values()];
    for (const q of params.queries ?? []) {
      const m = /equal\("([^"]+)","([^"]+)"\)/.exec(q);
      if (m) {
        const [, attr, value] = m;
        docs = docs.filter((d) => d[attr!] === value);
      }
    }
    return { total: docs.length, documents: docs };
  }
}

type RealtimeCb = (event: RealtimeResponseEvent<Models.Document>) => void;

export class FakeRealtime {
  private subs = new Map<string, Set<RealtimeCb>>();

  async subscribe(channel: string, callback: RealtimeCb): Promise<{ unsubscribe: () => Promise<void> }> {
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(callback);
    return {
      unsubscribe: async () => {
        set?.delete(callback);
      },
    };
  }

  async disconnect(): Promise<void> {
    this.subs.clear();
  }

  /** Deliver a document event to all subscribers of that collection channel. */
  emit(collectionId: string, doc: Doc, kind: 'create' | 'update' | 'delete'): void {
    const channel = `databases.main.collections.${collectionId}.documents`;
    const event: RealtimeResponseEvent<Models.Document> = {
      events: [`databases.main.collections.${collectionId}.documents.${doc.$id}.${kind}`],
      channels: [channel],
      timestamp: new Date().toISOString(),
      payload: doc as unknown as Models.Document,
      subscriptions: [],
    };
    queueMicrotask(() => {
      for (const cb of [...(this.subs.get(channel) ?? [])]) cb(event);
    });
  }
}
