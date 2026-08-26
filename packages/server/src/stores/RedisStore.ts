/**
 * RedisStore — optional Store backed by Redis (ioredis/redis).
 *
 * This is an *optional* scale-out store so deployments without Redis keep
 * working with Postgres/SQLite/MySQL/InMemory. When Redis is present, signals
 * are kept in a capped list + STREAM-like key and expired via TTL so the DB
 * does not grow unbounded.
 *
 * `ioredis`/`redis` are **optional peer deps** — this module never imports
 * them. Pass a minimal Redis client you already have:
 *
 * ```ts
 * import IORedis from 'ioredis';
 * import { RedisStore } from '@mbsks/openrtc-server/stores/redis';
 * const store = new RedisStore(new IORedis(url), { signalTtlMs: 60_000 });
 * ```
 *
 * Keys:
 *  - `vidcall:room:{roomId}` -> JSON room doc
 *  - `vidcall:part:{roomId}:{participantId}` -> JSON participant
 *  - `vidcall:parts:{roomId}` -> SET of participantIds
 *  - `vidcall:sig:{roomId}` -> ZSET `score=seq` -> JSON StoredSignal; or LIST + counter
 *  - `vidcall:rec:{sessionId}` -> JSON recording; `vidcall:recs:{roomId}` -> SET
 *  - `vidcall:seq:{roomId}` -> INCR counter
 */
import type { Envelope } from '@mbsks/openrtc-protocol';
import type { Store } from '../store.ts';
import type { BanEntry, LobbyEntry, Participant, Poll, RecordingSession, Room, StoredSignal } from '../types.ts';

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
  zrange?(key: string, start: number, stop: number): Promise<string[]>;
  zrem?(key: string, ...members: string[]): Promise<number>;
  expire?(key: string, seconds: number): Promise<number | unknown>;
  pexpire?(key: string, ms: number): Promise<number | unknown>;
}

export interface RedisStoreOptions {
  /** TTL for signal entries in ms; default 5 min (0 = no expiry). */
  signalTtlMs?: number;
  /** TTL for room/participant keys; default 0 (no expiry). */
  roomTtlMs?: number;
  /** Key prefix; default `vidcall`. */
  prefix?: string;
}

function k(prefix: string, ...parts: string[]): string { return [prefix, ...parts].join(':'); }

export class RedisStore implements Store {
  private readonly prefix: string;
  private readonly signalTtlMs: number;
  private readonly roomTtlMs: number;

  constructor(
    private readonly redis: RedisClientLike,
    opts: RedisStoreOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'vidcall';
    this.signalTtlMs = opts.signalTtlMs ?? 5 * 60 * 1000;
    this.roomTtlMs = opts.roomTtlMs ?? 0;
  }

  private rk(roomId: string): string { return k(this.prefix, 'room', roomId); }
  private pk(roomId: string, participantId: string): string { return k(this.prefix, 'part', roomId, participantId); }
  private ps(roomId: string): string { return k(this.prefix, 'parts', roomId); }
  private sk(roomId: string): string { return k(this.prefix, 'sig', roomId); }
  private seqk(roomId: string): string { return k(this.prefix, 'seq', roomId); }
  private reck(sessionId: string): string { return k(this.prefix, 'rec', sessionId); }
  private recs(roomId: string): string { return k(this.prefix, 'recs', roomId); }
  private recAll(): string { return k(this.prefix, 'recs', 'all'); }
  private bk(roomId: string, participantId: string): string { return k(this.prefix, 'ban', roomId, participantId); }
  private bs(roomId: string): string { return k(this.prefix, 'bans', roomId); }
  private lz(roomId: string): string { return k(this.prefix, 'lobby', roomId); }
  private hz(roomId: string): string { return k(this.prefix, 'hand', roomId); }
  private pollk(roomId: string, pollId: string): string { return k(this.prefix, 'poll', roomId, pollId); }
  private polls(roomId: string): string { return k(this.prefix, 'polls', roomId); }
  private lvalk(roomId: string, participantId: string): string { return k(this.prefix, 'lobbyval', roomId, participantId); }

  async getRoom(roomId: string): Promise<Room | null> {
    const v = await this.redis.get(this.rk(roomId));
    return v ? JSON.parse(v) as Room : null;
  }
  async putRoom(room: Room): Promise<void> {
    await this.redis.set(this.rk(room.roomId), JSON.stringify(room));
    if (this.roomTtlMs > 0) {
      const exp = this.redis.pexpire ?? this.redis.expire;
      if (exp) await exp.call(this.redis, this.rk(room.roomId), this.roomTtlMs > 1000 ? Math.ceil(this.roomTtlMs / 1000) : this.roomTtlMs).catch(() => {});
    }
  }
  async deleteRoom(roomId: string): Promise<void> {
    const ids = await this.redis.smembers(this.ps(roomId));
    const banIds = await this.redis.smembers(this.bs(roomId)).catch(() => [] as string[]);
    const pollIds = await this.redis.smembers(this.polls(roomId)).catch(() => [] as string[]);
    const recIds = await this.redis.smembers(this.recs(roomId)).catch(() => [] as string[]);
    const lobbyMembers = await this.redis.zrangebyscore(this.lz(roomId), '-inf', '+inf').catch(() => [] as string[]);
    const keys: string[] = [this.rk(roomId), this.ps(roomId), this.sk(roomId), this.seqk(roomId), this.recs(roomId), this.bs(roomId), this.lz(roomId), this.hz(roomId), this.polls(roomId)];
    for (const id of ids) keys.push(this.pk(roomId, id));
    for (const id of banIds) keys.push(this.bk(roomId, id));
    for (const id of pollIds) keys.push(this.pollk(roomId, id));
    for (const pid of lobbyMembers) keys.push(this.lvalk(roomId, pid));
    for (const sid of recIds) {
      keys.push(this.reck(sid));
      await this.redis.srem(this.recAll(), sid).catch(() => {});
    }
    if (keys.length) await this.redis.del(...keys);
  }

  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    const v = await this.redis.get(this.pk(roomId, participantId));
    return v ? JSON.parse(v) as Participant : null;
  }
  async putParticipant(p: Participant): Promise<void> {
    await this.redis.set(this.pk(p.roomId, p.participantId), JSON.stringify(p));
    await this.redis.sadd(this.ps(p.roomId), p.participantId);
  }
  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    await this.redis.del(this.pk(roomId, participantId));
    await this.redis.srem(this.ps(roomId), participantId);
  }
  async listParticipants(roomId: string): Promise<Participant[]> {
    const ids = await this.redis.smembers(this.ps(roomId));
    const out: Participant[] = [];
    for (const id of ids) {
      const v = await this.redis.get(this.pk(roomId, id));
      if (v) out.push(JSON.parse(v) as Participant);
    }
    out.sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
    return out;
  }

  async putSignal(signal: { roomId: string; envelope: Envelope; receivedAt: number }): Promise<StoredSignal> {
    const seq = await this.redis.incr(this.seqk(signal.roomId));
    const stored: StoredSignal = { roomId: signal.roomId, seq, envelope: signal.envelope, receivedAt: signal.receivedAt };
    await this.redis.zadd(this.sk(signal.roomId), seq, JSON.stringify(stored));
    if (this.signalTtlMs > 0 && this.redis.pexpire) {
      await this.redis.pexpire(this.sk(signal.roomId), this.signalTtlMs).catch(() => {});
    }
    return stored;
  }
  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    const members = await this.redis.zrangebyscore(this.sk(roomId), since + 1, '+inf');
    return members.map((m) => JSON.parse(m) as StoredSignal).sort((a, b) => a.seq - b.seq);
  }

  async putRecording(r: RecordingSession): Promise<void> {
    await this.redis.set(this.reck(r.sessionId), JSON.stringify(r));
    await this.redis.sadd(this.recs(r.roomId), r.sessionId);
    await this.redis.sadd(this.recAll(), r.sessionId).catch(() => {});
  }
  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    const ids = await this.redis.smembers(this.recs(roomId));
    const out: RecordingSession[] = [];
    for (const id of ids) {
      const v = await this.redis.get(this.reck(id));
      if (v) out.push(JSON.parse(v) as RecordingSession);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }
  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    const v = await this.redis.get(this.reck(sessionId));
    return v ? JSON.parse(v) as RecordingSession : null;
  }
  async deleteRecording(sessionId: string): Promise<void> {
    const v = await this.redis.get(this.reck(sessionId));
    if (v) {
      const rec = JSON.parse(v) as RecordingSession;
      await this.redis.srem(this.recs(rec.roomId), sessionId).catch(() => {});
    }
    await this.redis.srem(this.recAll(), sessionId).catch(() => {});
    await this.redis.del(this.reck(sessionId));
  }
  async listAllRecordings(): Promise<RecordingSession[]> {
    const ids = await this.redis.smembers(this.recAll()).catch(() => [] as string[]);
    const out: RecordingSession[] = [];
    for (const id of ids) {
      const v = await this.redis.get(this.reck(id));
      if (v) out.push(JSON.parse(v) as RecordingSession);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  // ---- bans --------------------------------------------------------------
  async listBans(roomId: string): Promise<BanEntry[]> {
    const ids = await this.redis.smembers(this.bs(roomId));
    const now = Date.now();
    const out: BanEntry[] = [];
    for (const id of ids) {
      const v = await this.redis.get(this.bk(roomId, id));
      if (!v) { await this.redis.srem(this.bs(roomId), id).catch(()=>{}); continue; }
      const e = JSON.parse(v) as BanEntry;
      if (e.expiresAt !== undefined && e.expiresAt <= now) {
        await this.redis.del(this.bk(roomId, id));
        await this.redis.srem(this.bs(roomId), id).catch(()=>{});
        continue;
      }
      out.push(e);
    }
    return out;
  }
  async getBan(roomId: string, participantId: string): Promise<BanEntry | null> {
    const v = await this.redis.get(this.bk(roomId, participantId));
    if (!v) return null;
    const e = JSON.parse(v) as BanEntry;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      await this.redis.del(this.bk(roomId, participantId));
      await this.redis.srem(this.bs(roomId), participantId).catch(()=>{});
      return null;
    }
    return e;
  }
  async putBan(roomId: string, entry: BanEntry): Promise<void> {
    await this.redis.set(this.bk(roomId, entry.participantId), JSON.stringify(entry));
    await this.redis.sadd(this.bs(roomId), entry.participantId);
  }
  async deleteBan(roomId: string, participantId: string): Promise<void> {
    await this.redis.del(this.bk(roomId, participantId));
    await this.redis.srem(this.bs(roomId), participantId).catch(()=>{});
  }

  // ---- lobby -------------------------------------------------------------
  async listLobby(roomId: string): Promise<LobbyEntry[]> {
    let members: string[] = [];
    if ((this.redis as unknown as { zrange?: unknown }).zrange) {
      try {
        members = await (this.redis as unknown as { zrange:(k:string,a:number,b:number)=>Promise<string[]> }).zrange(this.lz(roomId), 0, -1);
      } catch { members = await this.redis.zrangebyscore(this.lz(roomId), '-inf', '+inf'); }
    } else {
      members = await this.redis.zrangebyscore(this.lz(roomId), '-inf', '+inf');
    }
    const out: LobbyEntry[] = [];
    for (const pid of members) {
      const v = await this.redis.get(this.lvalk(roomId, pid)).catch(() => null);
      const enqueuedAt = v ? Number(v) : 0;
      out.push({ participantId: pid, enqueuedAt });
    }
    return out;
  }
  async putLobby(roomId: string, participantId: string, enqueuedAt: number): Promise<void> {
    await this.redis.zadd(this.lz(roomId), enqueuedAt, participantId);
    await this.redis.set(this.lvalk(roomId, participantId), String(enqueuedAt));
  }
  async deleteLobby(roomId: string, participantId: string): Promise<boolean> {
    await this.redis.del(this.lvalk(roomId, participantId)).catch(()=>{});
    if (this.redis.zrem) {
      const n = await this.redis.zrem(this.lz(roomId), participantId);
      return (n ?? 0) > 0;
    }
    await this.redis.srem(this.lz(roomId), participantId).catch(()=>{});
    return true;
  }

  // ---- hand queue --------------------------------------------------------
  async listHandQueue(roomId: string): Promise<string[]> {
    if ((this.redis as unknown as { zrange?: unknown }).zrange) {
      try {
        const ordered = await (this.redis as unknown as { zrange:(k:string,a:number,b:number)=>Promise<string[]> }).zrange(this.hz(roomId), 0, -1);
        if (ordered.length) return ordered;
      } catch {}
    }
    const members = await this.redis.zrangebyscore(this.hz(roomId), '-inf', '+inf');
    return members;
  }
  async addHand(roomId: string, participantId: string): Promise<void> {
    const existing = await this.redis.zrangebyscore(this.hz(roomId), '-inf', '+inf');
    if (existing.includes(participantId)) return;
    await this.redis.zadd(this.hz(roomId), Date.now(), participantId);
  }
  async removeHand(roomId: string, participantId: string): Promise<void> {
    if (this.redis.zrem) await this.redis.zrem(this.hz(roomId), participantId);
    else await this.redis.srem(this.hz(roomId), participantId).catch(()=>{});
  }

  // ---- polls -------------------------------------------------------------
  async listPolls(roomId: string): Promise<Poll[]> {
    const ids = await this.redis.smembers(this.polls(roomId));
    const out: Poll[] = [];
    for (const id of ids) {
      const v = await this.redis.get(this.pollk(roomId, id));
      if (v) out.push(JSON.parse(v) as Poll);
    }
    return out;
  }
  async getPoll(roomId: string, pollId: string): Promise<Poll | null> {
    const v = await this.redis.get(this.pollk(roomId, pollId));
    return v ? JSON.parse(v) as Poll : null;
  }
  async putPoll(roomId: string, poll: Poll): Promise<void> {
    await this.redis.set(this.pollk(roomId, poll.id), JSON.stringify(poll));
    await this.redis.sadd(this.polls(roomId), poll.id);
  }
  async votePoll(roomId: string, pollId: string, participantId: string, option: string): Promise<boolean> {
    const v = await this.redis.get(this.pollk(roomId, pollId));
    if (!v) return false;
    const poll = JSON.parse(v) as Poll;
    if (!poll.options.includes(option)) return false;
    poll.votes[participantId] = option;
    await this.redis.set(this.pollk(roomId, pollId), JSON.stringify(poll));
    return true;
  }
}
