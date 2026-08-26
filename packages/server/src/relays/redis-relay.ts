/**
 * RedisRelay — distributed Relay backed by Redis pub/sub (ioredis).
 *
 * One instance per server process. Broadcasts are published to
 * `vidcall:room:{roomId}` (JSON wrapper `{ envelope, exceptSenderId }`); the
 * subscriber fans out to local RoomHub sockets. `attach` subscribes on demand;
 * `detach` unsubscribes when the last local socket leaves the room so the
 * process does not receive traffic for empty rooms.
 *
 * `ioredis` (or `redis`) is an optional peer dep — this module never imports
 * it. Pass `pub` and `sub` clients you already created:
 *
 * ```ts
 * import IORedis from 'ioredis';
 * import { RedisRelay } from '@mbsks/openrtc-server/relays/redis';
 * const relay = new RedisRelay(new IORedis(url), new IORedis(url));
 * attachWebSocketRelay(server, services, { relay });
 * ```
 */
import type { Envelope } from '@mbsks/openrtc-protocol';
import { isEnvelope } from '@mbsks/openrtc-protocol';
import type { Relay } from '../services.ts';
import { RoomHub } from '../ws.ts';

export interface RedisPub {
  publish(channel: string, message: string): Promise<number>;
}

export interface RedisSub {
  subscribe(channel: string): Promise<void> | void;
  unsubscribe(channel: string): Promise<void> | void;
  on(event: 'message', handler: (channel: string, message: string) => void): void;
  off?(event: 'message' | string, handler: (...args: unknown[]) => void): void;
}

function channelFor(roomId: string): string {
  return `vidcall:room:${roomId}`;
}

interface WireWrapper {
  envelope: Envelope;
  exceptSenderId?: string;
}

export class RedisRelay implements Relay {
  private readonly local = new RoomHub();
  private readonly subscribed = new Set<string>();
  private readonly pub: RedisPub;
  private readonly sub: RedisSub;

  constructor(pub: RedisPub, sub: RedisSub) {
    this.pub = pub;
    this.sub = sub;
    this.sub.on('message', (channel: string, message: string) => {
      if (!channel.startsWith('vidcall:room:')) return;
      let wrapper: WireWrapper | Envelope | unknown;
      try {
        wrapper = JSON.parse(message) as unknown;
      } catch {
        return;
      }
      let envelope: Envelope | undefined;
      let exceptSenderId: string | undefined;
      if (wrapper && typeof wrapper === 'object' && 'envelope' in (wrapper as Record<string, unknown>)) {
        const w = wrapper as WireWrapper;
        if (isEnvelope(w.envelope)) {
          envelope = w.envelope;
          exceptSenderId = w.exceptSenderId;
        }
      } else if (isEnvelope(wrapper)) {
        envelope = wrapper as Envelope;
      }
      if (!envelope) return;
      const roomId = envelope.roomId;
      this.local.broadcast(roomId, envelope, exceptSenderId ? { exceptSenderId } : undefined);
    });
  }

  attach(roomId: string, socket: import('ws').WebSocket, senderId: string, sessionId: string): void {
    this.local.attach(roomId, socket, senderId, sessionId);
    const ch = channelFor(roomId);
    if (!this.subscribed.has(ch)) {
      this.subscribed.add(ch);
      void this.sub.subscribe(ch);
    }
  }

  detach(roomId: string, socket: import('ws').WebSocket): void {
    this.local.detach(roomId, socket);
    if (this.local.clientCount(roomId) === 0) {
      const ch = channelFor(roomId);
      if (this.subscribed.has(ch)) {
        this.subscribed.delete(ch);
        void this.sub.unsubscribe(ch);
      }
    }
  }

  broadcast(roomId: string, envelope: Envelope, opts?: { exceptSenderId?: string }): void {
    // Fast local fan-out.
    this.local.broadcast(roomId, envelope, opts);
    const wrapper: WireWrapper = opts?.exceptSenderId
      ? { envelope, exceptSenderId: opts.exceptSenderId }
      : { envelope };
    const ch = channelFor(roomId);
    void this.pub.publish(ch, JSON.stringify(wrapper)).catch(() => {});
  }

  clientCount(roomId: string): number {
    return this.local.clientCount(roomId);
  }

  metaFor(socket: import('ws').WebSocket): { roomId: string | null; senderId: string | null; sessionId: string | null } | undefined {
    return this.local.metaFor(socket);
  }

  /** Expose the underlying local hub for diagnostics. */
  get hub(): RoomHub {
    return this.local;
  }
}
