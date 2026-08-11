/**
 * In-memory Firebase Realtime Database for unit tests.
 *
 * Mirrors the subset of the firebase/database API that FirebaseBackend uses:
 *  - ref / push / set / update / remove
 *  - onChildAdded (fires for existing children first, then new ones — in key
 *    order, like real RTDB)
 *  - onValue (full snapshot on every change)
 *  - off / onDisconnect (set/update/cancel hooks executed on disconnect)
 *
 * Listener registrations are keyed by REF OBJECT IDENTITY — like real
 * Firebase, where each client's listeners are independent and `off(ref)`
 * only detaches that client's own listeners.
 *
 * The test file exposes this via `vi.mock('firebase/database')` so the
 * adapter talks to a real-shaped fake. `sharedFakeDb` is the singleton the
 * mock factory binds to; tests import the same instance to reset state and
 * simulate disconnects.
 */

export interface DataSnapshotLike {
  key: string | null;
  val(): unknown;
}

export interface FakeRef {
  key: string | null;
  path: string;
}

type Listener = { ref: FakeRef; cb: (snap: DataSnapshotLike) => void };

export class FakeFirebaseDb {
  data: Record<string, unknown> = {};
  private childAdded: Listener[] = [];
  private valueListeners: Listener[] = [];
  private disconnectHooks = new Map<string, { op: 'set' | 'update'; value: unknown }>();
  private pushCounter = 0;

  reset(): void {
    this.data = {};
    this.childAdded = [];
    this.valueListeners = [];
    this.disconnectHooks.clear();
    this.pushCounter = 0;
  }

  ref(path: string): FakeRef {
    const clean = path.replace(/^\//, '').replace(/\/$/, '');
    const segments = clean === '' ? [] : clean.split('/');
    return { key: segments.length ? segments[segments.length - 1]! : null, path: clean };
  }

  private getAt(path: string): unknown {
    if (path === '') return this.data;
    let cur: unknown = this.data;
    for (const seg of path.split('/')) {
      if (cur === null || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur ?? null;
  }

  private setAt(path: string, value: unknown): void {
    if (path === '') {
      this.data = (value ?? {}) as Record<string, unknown>;
      return;
    }
    const segs = path.split('/');
    let cur = this.data;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      const next = (cur as Record<string, unknown>)[seg];
      if (next === null || typeof next !== 'object') {
        const fresh: Record<string, unknown> = {};
        (cur as Record<string, unknown>)[seg] = fresh;
        cur = fresh;
      } else {
        cur = next as Record<string, unknown>;
      }
    }
    if (value === null || value === undefined) {
      delete (cur as Record<string, unknown>)[segs[segs.length - 1]!];
    } else {
      (cur as Record<string, unknown>)[segs[segs.length - 1]!] = value;
    }
  }

  private snapshotAt(path: string): DataSnapshotLike {
    const value = this.getAt(path);
    const segs = path.split('/');
    return {
      key: segs.length ? segs[segs.length - 1]! : null,
      val: () => value,
    };
  }

  private fireValue(path: string): void {
    for (const l of this.valueListeners) {
      // value events propagate to ancestors of the changed path
      if (path === l.ref.path || path.startsWith(l.ref.path === '' ? '' : l.ref.path + '/')) {
        l.cb(this.snapshotAt(l.ref.path));
      }
    }
  }

  private fireChildAdded(path: string, childKey: string): void {
    const childPath = path === '' ? childKey : `${path}/${childKey}`;
    for (const l of this.childAdded) {
      if (l.ref.path === path) l.cb(this.snapshotAt(childPath));
    }
  }

  push(parent: FakeRef, value: unknown): FakeRef {
    const key = `push_${String(++this.pushCounter).padStart(8, '0')}`;
    const childPath = parent.path === '' ? key : `${parent.path}/${key}`;
    this.setAt(childPath, value);
    this.fireChildAdded(parent.path, key);
    this.fireValue(parent.path);
    return { key, path: childPath };
  }

  async set(r: FakeRef, value: unknown): Promise<void> {
    this.setAt(r.path, value);
    this.fireValue(r.path);
  }

  async update(r: FakeRef, values: Record<string, unknown>): Promise<void> {
    const cur = (this.getAt(r.path) as Record<string, unknown> | null) ?? {};
    this.setAt(r.path, { ...cur, ...values });
    this.fireValue(r.path);
  }

  async remove(r: FakeRef): Promise<void> {
    this.setAt(r.path, null);
    this.fireValue(r.path);
  }

  onChildAdded(q: FakeRef, cb: (snap: DataSnapshotLike) => void): () => void {
    const entry: Listener = { ref: q, cb };
    this.childAdded.push(entry);
    // fire existing children first, in key order (like real RTDB)
    const existing = this.getAt(q.path);
    if (existing !== null && typeof existing === 'object') {
      const keys = Object.keys(existing as Record<string, unknown>).sort();
      for (const key of keys) {
        if ((existing as Record<string, unknown>)[key] !== null) this.fireChildAdded(q.path, key);
      }
    }
    return () => {
      const idx = this.childAdded.indexOf(entry);
      if (idx >= 0) this.childAdded.splice(idx, 1);
    };
  }

  onValue(q: FakeRef, cb: (snap: DataSnapshotLike) => void): () => void {
    const entry: Listener = { ref: q, cb };
    this.valueListeners.push(entry);
    queueMicrotask(() => cb(this.snapshotAt(q.path)));
    return () => {
      const idx = this.valueListeners.indexOf(entry);
      if (idx >= 0) this.valueListeners.splice(idx, 1);
    };
  }

  off(q: FakeRef, _eventType?: string, cb?: (snap: DataSnapshotLike) => void): void {
    if (cb) {
      this.childAdded = this.childAdded.filter((l) => !(l.ref === q && l.cb === cb));
      this.valueListeners = this.valueListeners.filter((l) => !(l.ref === q && l.cb === cb));
      return;
    }
    this.childAdded = this.childAdded.filter((l) => l.ref !== q);
    this.valueListeners = this.valueListeners.filter((l) => l.ref !== q);
  }

  onDisconnect(r: FakeRef): {
    set(value: unknown): Promise<void>;
    update(values: Record<string, unknown>): Promise<void>;
    cancel(): Promise<void>;
    remove(): Promise<void>;
  } {
    return {
      set: (value) => {
        this.disconnectHooks.set(r.path, { op: 'set', value });
        return Promise.resolve();
      },
      update: (values) => {
        this.disconnectHooks.set(r.path, { op: 'update', value: values });
        return Promise.resolve();
      },
      cancel: () => {
        this.disconnectHooks.delete(r.path);
        return Promise.resolve();
      },
      remove: () => {
        this.disconnectHooks.set(r.path, { op: 'set', value: null });
        return Promise.resolve();
      },
    };
  }

  /** Simulate the peer identified by `userId` dropping its connection: runs its
   * armed onDisconnect hooks (like the RTDB server would). */
  simulateDisconnect(userId: string): void {
    const paths = [...this.disconnectHooks.keys()].filter((p) => p.split('/').includes(userId));
    for (const p of paths) {
      const hook = this.disconnectHooks.get(p)!;
      this.disconnectHooks.delete(p);
      if (hook.op === 'set') {
        this.setAt(p, hook.value);
      } else {
        const cur = (this.getAt(p) as Record<string, unknown> | null) ?? {};
        this.setAt(p, { ...cur, ...(hook.value as Record<string, unknown>) });
      }
      this.fireValue(p);
    }
  }
}

/** Singleton the vi.mock factory binds to; tests import the same instance. */
export const sharedFakeDb = new FakeFirebaseDb();
