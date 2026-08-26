/**
 * In-memory `Store` — the reference implementation and the one used by the
 * test suite, dev servers, and single-process demos. Every other store
 * (`SqliteStore`, `PostgresStore`, `MysqlStore`) must behave identically.
 *
 * Not for multi-process production use: state lives in one Node process.
 */

import type { Envelope } from '@mbsks/openrtc-protocol';
import type { Store } from '../store.ts';
import type { BanEntry, LobbyEntry, Participant, Poll, RecordingSession, Room, StoredSignal } from '../types.ts';

export class InMemoryStore implements Store {
  private readonly rooms = new Map<string, Room>();
  private readonly participants = new Map<string, Participant>();
  private readonly signals = new Map<string, StoredSignal[]>();
  private readonly signalSeqs = new Map<string, number>();
  private readonly recordings = new Map<string, RecordingSession>();
  private readonly bans = new Map<string, Map<string, BanEntry>>();
  private readonly lobbies = new Map<string, Map<string, number>>();
  private readonly handQueues = new Map<string, string[]>();
  private readonly polls = new Map<string, Map<string, Poll>>();

  // ---- rooms -------------------------------------------------------------
  async getRoom(roomId: string): Promise<Room | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async putRoom(room: Room): Promise<void> {
    this.rooms.set(room.roomId, structuredClone(room));
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    for (const key of [...this.participants.keys()]) {
      if (key.startsWith(`${roomId}\u0000`)) this.participants.delete(key);
    }
    this.signals.delete(roomId);
    this.signalSeqs.delete(roomId);
    for (const [sessionId, r] of this.recordings) {
      if (r.roomId === roomId) this.recordings.delete(sessionId);
    }
    this.bans.delete(roomId);
    this.lobbies.delete(roomId);
    this.handQueues.delete(roomId);
    this.polls.delete(roomId);
  }

  // ---- participants ------------------------------------------------------
  private static key(roomId: string, participantId: string): string {
    return `${roomId}\u0000${participantId}`;
  }

  async getParticipant(roomId: string, participantId: string): Promise<Participant | null> {
    return this.participants.get(InMemoryStore.key(roomId, participantId)) ?? null;
  }

  async putParticipant(participant: Participant): Promise<void> {
    this.participants.set(InMemoryStore.key(participant.roomId, participant.participantId), {
      ...structuredClone(participant),
    });
  }

  async deleteParticipant(roomId: string, participantId: string): Promise<void> {
    this.participants.delete(InMemoryStore.key(roomId, participantId));
  }

  async listParticipants(roomId: string): Promise<Participant[]> {
    const prefix = `${roomId}\u0000`;
    const out: Participant[] = [];
    for (const [key, p] of this.participants) {
      if (key.startsWith(prefix)) out.push(structuredClone(p));
    }
    out.sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
    return out;
  }

  // ---- signals -----------------------------------------------------------
  async putSignal(signal: {
    roomId: string;
    envelope: Envelope;
    receivedAt: number;
  }): Promise<StoredSignal> {
    const seq = (this.signalSeqs.get(signal.roomId) ?? 0) + 1;
    this.signalSeqs.set(signal.roomId, seq);
    const stored: StoredSignal = {
      roomId: signal.roomId,
      seq,
      envelope: structuredClone(signal.envelope),
      receivedAt: signal.receivedAt,
    };
    const list = this.signals.get(signal.roomId) ?? [];
    list.push(stored);
    this.signals.set(signal.roomId, list);
    return structuredClone(stored);
  }

  async listSignals(roomId: string, since: number): Promise<StoredSignal[]> {
    const list = this.signals.get(roomId) ?? [];
    return list.filter((s) => s.seq > since).map((s) => structuredClone(s));
  }

  // ---- recordings --------------------------------------------------------
  async putRecording(recording: RecordingSession): Promise<void> {
    this.recordings.set(recording.sessionId, structuredClone(recording));
  }

  async listRecordings(roomId: string): Promise<RecordingSession[]> {
    return [...this.recordings.values()]
      .filter((r) => r.roomId === roomId)
      .map((r) => structuredClone(r));
  }

  async getRecording(sessionId: string): Promise<RecordingSession | null> {
    return this.recordings.get(sessionId) ? structuredClone(this.recordings.get(sessionId)!) : null;
  }

  async deleteRecording(sessionId: string): Promise<void> {
    this.recordings.delete(sessionId);
  }

  async listAllRecordings(): Promise<RecordingSession[]> {
    return [...this.recordings.values()].map((r) => structuredClone(r));
  }

  // ---- bans --------------------------------------------------------------
  async listBans(roomId: string): Promise<BanEntry[]> {
    const m = this.bans.get(roomId);
    if (!m) return [];
    const now = Date.now();
    const out: BanEntry[] = [];
    for (const [pid, e] of [...m.entries()]) {
      if (e.expiresAt !== undefined && e.expiresAt <= now) { m.delete(pid); continue; }
      out.push(structuredClone(e));
    }
    return out;
  }

  async getBan(roomId: string, participantId: string): Promise<BanEntry | null> {
    const m = this.bans.get(roomId);
    if (!m) return null;
    const e = m.get(participantId);
    if (!e) return null;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) { m.delete(participantId); return null; }
    return structuredClone(e);
  }

  async putBan(roomId: string, entry: BanEntry): Promise<void> {
    let m = this.bans.get(roomId);
    if (!m) { m = new Map(); this.bans.set(roomId, m); }
    m.set(entry.participantId, structuredClone(entry));
  }

  async deleteBan(roomId: string, participantId: string): Promise<void> {
    this.bans.get(roomId)?.delete(participantId);
  }

  // ---- lobby -------------------------------------------------------------
  async listLobby(roomId: string): Promise<LobbyEntry[]> {
    const m = this.lobbies.get(roomId);
    if (!m) return [];
    return [...m.entries()].map(([participantId, enqueuedAt]) => ({ participantId, enqueuedAt }));
  }

  async putLobby(roomId: string, participantId: string, enqueuedAt: number): Promise<void> {
    let m = this.lobbies.get(roomId);
    if (!m) { m = new Map(); this.lobbies.set(roomId, m); }
    m.set(participantId, enqueuedAt);
  }

  async deleteLobby(roomId: string, participantId: string): Promise<boolean> {
    const m = this.lobbies.get(roomId);
    if (!m) return false;
    return m.delete(participantId);
  }

  // ---- hand queue --------------------------------------------------------
  async listHandQueue(roomId: string): Promise<string[]> {
    return [...(this.handQueues.get(roomId) ?? [])];
  }

  async addHand(roomId: string, participantId: string): Promise<void> {
    const q = this.handQueues.get(roomId) ?? [];
    if (!q.includes(participantId)) q.push(participantId);
    this.handQueues.set(roomId, q);
  }

  async removeHand(roomId: string, participantId: string): Promise<void> {
    const q = this.handQueues.get(roomId) ?? [];
    this.handQueues.set(roomId, q.filter((id) => id !== participantId));
  }

  // ---- polls -------------------------------------------------------------
  async listPolls(roomId: string): Promise<Poll[]> {
    const m = this.polls.get(roomId);
    if (!m) return [];
    return [...m.values()].map((p) => structuredClone(p));
  }

  async getPoll(roomId: string, pollId: string): Promise<Poll | null> {
    const p = this.polls.get(roomId)?.get(pollId);
    return p ? structuredClone(p) : null;
  }

  async putPoll(roomId: string, poll: Poll): Promise<void> {
    let m = this.polls.get(roomId);
    if (!m) { m = new Map(); this.polls.set(roomId, m); }
    m.set(poll.id, structuredClone(poll));
  }

  async votePoll(roomId: string, pollId: string, participantId: string, option: string): Promise<boolean> {
    const m = this.polls.get(roomId)?.get(pollId);
    if (!m) return false;
    if (!m.options.includes(option)) return false;
    m.votes[participantId] = option;
    return true;
  }

  /** True when the store holds any state (test helper). */
  isEmpty(): boolean {
    return (
      this.rooms.size === 0 &&
      this.participants.size === 0 &&
      this.signals.size === 0 &&
      this.recordings.size === 0
    );
  }
}
