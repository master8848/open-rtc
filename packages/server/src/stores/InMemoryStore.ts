/**
 * In-memory `Store` — the reference implementation and the one used by the
 * test suite, dev servers, and single-process demos. Every other store
 * (`SqliteStore`, `PostgresStore`, `MysqlStore`) must behave identically.
 *
 * Not for multi-process production use: state lives in one Node process.
 */

import type { Envelope } from '@mbsks/protocol';
import type { Store } from '../store.ts';
import type { Participant, RecordingSession, Room, StoredSignal } from '../types.ts';

export class InMemoryStore implements Store {
  private readonly rooms = new Map<string, Room>();
  private readonly participants = new Map<string, Participant>();
  private readonly signals = new Map<string, StoredSignal[]>();
  private readonly signalSeqs = new Map<string, number>();
  private readonly recordings = new Map<string, RecordingSession>();

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
    return this.recordings.get(sessionId) ?? null;
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
