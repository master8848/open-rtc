/**
 * In-memory Supabase Realtime fake for unit tests.
 *
 * Simulates the parts of @supabase/supabase-js that SupabaseBackend uses:
 *  - client.channel(room) / client.removeChannel(channel)
 *  - channel.on('broadcast' | 'presence', filter, cb)
 *  - channel.subscribe / unsubscribe / send / track / untrack / presenceState
 *
 * A FakeRealtimeBus wires multiple FakeChannels in the same room together,
 * mirroring Phoenix pub/sub semantics: broadcast reaches every OTHER channel
 * in the room; presence is a merged per-room view with join/leave/sync
 * events. Delivery is asynchronous (microtask), like a real WebSocket.
 */
import type { Envelope } from '@mbsks/protocol';

export interface TrackedPresence {
  id: string;
  state: string;
  metadata?: Record<string, unknown>;
  displayName?: string;
  ts?: number;
  [key: string]: unknown;
}

type Listener = { type: string; filterEvent: string | null; cb: (payload: never) => void };

let uidCounter = 0;

export class FakeChannel {
  readonly uid = `ch-${++uidCounter}`;
  readonly listeners: Listener[] = [];

  constructor(
    public readonly bus: FakeRealtimeBus,
    public readonly room: string,
  ) {}

  on(type: string, filter: { event?: string } | undefined, cb: (payload: never) => void): this {
    this.listeners.push({ type, filterEvent: filter?.event ?? null, cb });
    return this;
  }

  subscribe(cb: (status: string, err?: Error) => void): this {
    queueMicrotask(() => cb('SUBSCRIBED'));
    return this;
  }

  async unsubscribe(): Promise<'ok'> {
    this.bus.unregister(this);
    return 'ok';
  }

  async send(msg: { type: 'broadcast'; event: string; payload: unknown }): Promise<'ok'> {
    this.bus.broadcast(this, msg.event, msg.payload);
    return 'ok';
  }

  async track(entry: TrackedPresence): Promise<void> {
    this.bus.track(this, entry);
  }

  async untrack(): Promise<void> {
    this.bus.untrack(this);
  }

  presenceState(): Record<string, TrackedPresence[]> {
    return this.bus.presenceState(this);
  }

  // --- internal event delivery (called by the bus) ---
  _emitBroadcast(event: string, payload: unknown): void {
    for (const l of this.listeners) {
      if (l.type === 'broadcast' && (l.filterEvent === '*' || l.filterEvent === event)) {
        l.cb({ type: 'broadcast', event, payload } as never);
      }
    }
  }

  _emitPresence(event: string, payload: unknown): void {
    for (const l of this.listeners) {
      if (l.type === 'presence' && l.filterEvent === event) {
        l.cb(payload as never);
      }
    }
  }
}

export class FakeRealtimeBus {
  private rooms = new Map<string, Map<FakeChannel, string | null>>();
  private presence = new Map<string, Map<string, TrackedPresence>>();

  register(ch: FakeChannel, room: string): void {
    let channels = this.rooms.get(room);
    if (!channels) {
      channels = new Map();
      this.rooms.set(room, channels);
    }
    channels.set(ch, null);
    if (!this.presence.has(room)) this.presence.set(room, new Map());
  }

  unregister(ch: FakeChannel): void {
    // unregistering also untracks presence (supabase removes presence on unsubscribe)
    const room = this.findRoom(ch);
    if (room) this.doUntrack(ch, room);
    for (const [roomName, channels] of this.rooms) {
      if (channels.delete(ch) && channels.size === 0) {
        this.rooms.delete(roomName);
        this.presence.delete(roomName);
      }
    }
  }

  private findRoom(ch: FakeChannel): string | null {
    for (const [room, channels] of this.rooms) {
      if (channels.has(ch)) return room;
    }
    return null;
  }

  private otherChannels(ch: FakeChannel, room: string): FakeChannel[] {
    const channels = this.rooms.get(room);
    if (!channels) return [];
    return [...channels.keys()].filter((c) => c !== ch);
  }

  broadcast(from: FakeChannel, event: string, payload: unknown): void {
    const room = this.findRoom(from);
    if (!room) return;
    for (const other of this.otherChannels(from, room)) {
      queueMicrotask(() => other._emitBroadcast(event, payload));
    }
  }

  track(ch: FakeChannel, entry: TrackedPresence): void {
    const room = this.findRoom(ch);
    if (!room) return;
    const key = `${entry.id}:${ch.uid}`;
    this.rooms.get(room)!.set(ch, key);
    this.presence.get(room)!.set(key, entry);
    for (const other of this.otherChannels(ch, room)) {
      queueMicrotask(() => other._emitPresence('join', { key, newPresences: [entry] }));
      queueMicrotask(() => other._emitPresence('sync', {}));
    }
  }

  private doUntrack(ch: FakeChannel, room: string): void {
    const key = this.rooms.get(room)?.get(ch) ?? null;
    if (key === null) return;
    const entry = this.presence.get(room)!.get(key);
    this.presence.get(room)!.delete(key);
    this.rooms.get(room)!.set(ch, null);
    if (entry) {
      for (const other of this.otherChannels(ch, room)) {
        queueMicrotask(() => other._emitPresence('leave', { key, leftPresences: [entry] }));
      }
    }
  }

  untrack(ch: FakeChannel): void {
    const room = this.findRoom(ch);
    if (!room) return;
    this.doUntrack(ch, room);
  }

  presenceState(ch: FakeChannel): Record<string, TrackedPresence[]> {
    const room = this.findRoom(ch);
    const out: Record<string, TrackedPresence[]> = {};
    if (!room) return out;
    for (const [key, entry] of this.presence.get(room)!) {
      out[key] = [entry];
    }
    return out;
  }
}

export class FakeSupabaseClient {
  constructor(public readonly bus: FakeRealtimeBus) {}

  channel(room: string): FakeChannel {
    const ch = new FakeChannel(this.bus, room);
    this.bus.register(ch, room);
    return ch;
  }

  async removeChannel(ch: FakeChannel): Promise<void> {
    this.bus.unregister(ch);
  }
}

/** Create an envelope helper for tests. */
export function makeEnv(room: string, sender: string, seq: number, session = 's'): Parameters<typeof import('@mbsks/protocol').createEnvelope>[1] {
  return { roomId: room, senderId: sender, sessionId: session, seq, ts: Date.now() };
}

export function isEnvelope(x: unknown): x is Envelope {
  return typeof x === 'object' && x !== null && typeof (x as { v?: unknown }).v === 'number' && typeof (x as { type?: unknown }).type === 'string';
}
