/**
 * In-memory ConvexClient fake for unit tests.
 *
 * Simulates the subset of the Convex browser client that ConvexBackend uses:
 *  - onUpdate(name, args, cb)  — live query; cb is invoked with the FULL
 *    result set on every change (like real Convex subscriptions);
 *  - mutation(name, args)       — applied to the shared in-memory store, then
 *    subscribers are re-notified;
 *  - close().
 *
 * The store mirrors the reference schema: `signals` (append-only rows with
 * lexically-sortable _ids) and `presence` (one row per room/user).
 */
export interface SignalRow {
  _id: string;
  roomId: string;
  frame: string;
}

export interface PresenceRow {
  _id: string;
  roomId: string;
  userId: string;
  state: string;
  metadata?: Record<string, unknown>;
  lastSeen: number;
}

type Sub = { name: string; args: Record<string, unknown>; cb: (rows: unknown) => void };

/** The adapter passes structural FunctionReference objects ({ _name }) — unwrap them. */
function refName(ref: string | { _name: string }): string {
  return typeof ref === 'string' ? ref : ref._name;
}

let idCounter = 0;

export class FakeConvexServer {
  private signals: SignalRow[] = [];
  private presence: PresenceRow[] = [];
  private subs = new Map<FakeConvexClient, Sub[]>();

  register(client: FakeConvexClient): void {
    this.subs.set(client, []);
  }

  unregister(client: FakeConvexClient): void {
    this.subs.delete(client);
  }

  onUpdate(client: FakeConvexClient, ref: string | { _name: string }, args: Record<string, unknown>, cb: (rows: unknown) => void): void {
    const name = refName(ref);
    const subs = this.subs.get(client)!;
    subs.push({ name, args, cb });
    // Convex pushes the current value immediately on subscribe
    queueMicrotask(() => cb(this.compute(name, args)));
  }

  unsubscribe(client: FakeConvexClient, name: string, args: Record<string, unknown>): void {
    const subs = this.subs.get(client);
    if (!subs) return;
    const idx = subs.findIndex((s) => s.name === name && s.args.roomId === args.roomId);
    if (idx >= 0) subs.splice(idx, 1);
  }

  mutation(client: FakeConvexClient, ref: string | { _name: string }, args: Record<string, unknown>): void {
    const name = refName(ref);
    if (name === 'signals:send') {
      const roomId = args.roomId as string;
      const frame = args.frame as string;
      this.signals.push({ _id: `sig_${(++idCounter).toString(36).padStart(8, '0')}`, roomId, frame });
    } else if (name === 'presence:upsert') {
      const roomId = args.roomId as string;
      const userId = args.userId as string;
      const idx = this.presence.findIndex((r) => r.roomId === roomId && r.userId === userId);
      if (idx >= 0) {
        // immutable replace — like real Convex values, subscribers must see
        // a NEW snapshot object so the adapter's diff sees the change
        const prev = this.presence[idx]!;
        this.presence[idx] = {
          ...prev,
          state: args.state as string,
          metadata: args.metadata as Record<string, unknown> | undefined,
          lastSeen: args.lastSeen as number,
        };
      } else {
        this.presence.push({
          _id: `pres_${(++idCounter).toString(36).padStart(8, '0')}`,
          roomId,
          userId,
          state: args.state as string,
          metadata: args.metadata as Record<string, unknown> | undefined,
          lastSeen: args.lastSeen as number,
        });
      }
    } else if (name === 'presence:remove') {
      const roomId = args.roomId as string;
      const userId = args.userId as string;
      this.presence = this.presence.filter((r) => !(r.roomId === roomId && r.userId === userId));
    } else {
      throw new Error(`FakeConvexServer: unknown mutation ${name}`);
    }
    // notify all affected subscribers (async, like the real sync worker)
    queueMicrotask(() => this.notifyAll());
  }

  private compute(name: string, args: Record<string, unknown>): unknown {
    const roomId = args.roomId as string;
    if (name === 'signals:list') {
      return this.signals.filter((s) => s.roomId === roomId).sort((a, b) => (a._id < b._id ? -1 : 1));
    }
    if (name === 'presence:list') {
      return this.presence.filter((p) => p.roomId === roomId);
    }
    return [];
  }

  private notifyAll(): void {
    for (const [client, subs] of this.subs) {
      for (const sub of [...subs]) {
        sub.cb(this.compute(sub.name, sub.args));
      }
    }
  }
}

export class FakeConvexClient {
  constructor(public readonly server: FakeConvexServer) {
    this.server.register(this);
  }

  onUpdate(ref: string | { _name: string }, args: Record<string, unknown>, cb: (rows: unknown) => void): () => void {
    const name = refName(ref);
    this.server.onUpdate(this, name, args, cb);
    return () => this.server.unsubscribe(this, name, args);
  }

  async mutation(ref: string | { _name: string }, args: Record<string, unknown>): Promise<void> {
    this.server.mutation(this, ref, args);
  }

  async close(): Promise<void> {
    this.server.unregister(this);
  }
}
