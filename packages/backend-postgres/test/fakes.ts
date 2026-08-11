/**
 * In-memory `pg` fake for unit tests.
 *
 * Simulates the subset of node-postgres that PostgresBackend uses:
 *  - query('LISTEN ch') / query('UNLISTEN ch')
 *  - query('NOTIFY ch, $1', [json])
 *  - query(INSERT/UPDATE vidcall_presence ...) / SELECT / DELETE
 *  - client.on('notification') events
 *
 * A FakePgBus wires clients together like a real Postgres server:
 * notifications are delivered to every OTHER client LISTENing on that
 * channel (async, like the real event loop), and the presence table is a
 * shared in-memory store.
 */
import { EventEmitter } from 'node:events';

export interface PresenceRow {
  id: string;
  state: string;
  metadata?: Record<string, unknown> | null;
  lastSeen: number;
}

export class FakePgBus {
  private listeners = new Map<string, Set<FakePgClient>>();
  private presence = new Map<string, Map<string, PresenceRow>>();

  listen(ch: FakePgClient, channel: string): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(ch);
  }

  unlisten(ch: FakePgClient, channel: string): void {
    this.listeners.get(channel)?.delete(ch);
  }

  notify(from: FakePgClient, channel: string, payload: string): void {
    for (const other of this.listeners.get(channel) ?? []) {
      if (other === from) continue;
      queueMicrotask(() => {
        if (!other.ended) other.emit('notification', { channel, payload, processId: 42 });
      });
    }
  }

  // --- presence table ---
  upsert(room: string, userId: string, row: PresenceRow): void {
    let map = this.presence.get(room);
    if (!map) {
      map = new Map();
      this.presence.set(room, map);
    }
    map.set(userId, row);
  }

  remove(room: string, userId: string): boolean {
    const map = this.presence.get(room);
    if (!map) return false;
    return map.delete(userId);
  }

  list(room: string): PresenceRow[] {
    const map = this.presence.get(room);
    if (!map) return [];
    return [...map.values()];
  }
}

let clientCounter = 0;

export class FakePgClient extends EventEmitter {
  readonly uid = `pg-${++clientCounter}`;
  ended = false;
  constructor(
    public readonly bus: FakePgBus,
    public readonly connectionString?: string,
  ) {
    super();
  }

  async connect(): Promise<void> {}

  async end(): Promise<void> {
    this.ended = true;
  }

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    if (sql.startsWith('LISTEN')) {
      const ch = sql.slice('LISTEN '.length).trim().replace(/"/g, '');
      this.bus.listen(this, ch);
      return { rows: [] };
    }
    if (sql.startsWith('UNLISTEN')) {
      const ch = sql.slice('UNLISTEN '.length).trim().replace(/"/g, '');
      this.bus.unlisten(this, ch);
      return { rows: [] };
    }
    if (sql.startsWith('NOTIFY')) {
      const ch = sql.slice('NOTIFY '.length).split(',')[0]!.trim().replace(/"/g, '');
      const payload = params?.[0] as string | undefined;
      if (payload !== undefined) this.bus.notify(this, ch, payload);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT')) {
      // params: [room, userId, state, metadata, lastSeen]
      const [room, userId, state, metadata, lastSeen] = params as [string, string, string, unknown, number];
      this.bus.upsert(room, userId, { id: userId, state, metadata: metadata as Record<string, unknown> | null, lastSeen });
      return { rows: [] };
    }
    if (sql.startsWith('DELETE')) {
      const [room, userId] = params as [string, string];
      this.bus.remove(room, userId);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT')) {
      const [room] = params as [string];
      return { rows: this.bus.list(room) };
    }
    throw new Error(`FakePgClient: unhandled SQL: ${sql}`);
  }
}
