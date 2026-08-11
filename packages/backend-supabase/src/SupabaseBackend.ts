/**
 * SupabaseBackend — vidcall signaling adapter for Supabase Realtime.
 *
 * Realtime channels give us BOTH primitives out of the box (research doc §4):
 *  - **broadcast**: ephemeral client<->client messages — carries the JSON
 *    signaling envelope (SDP offer/answer, trickle ICE, reactions, chat);
 *  - **presence**: each client tracks a small payload; the server merges the
 *    per-room view — powers "who's in the call".
 *
 * Adapter policy:
 *  - `emit` -> `channel.send({ type:'broadcast', event: <kind>, payload })`;
 *  - ICE candidates are coalesced into a 100 ms window by default (Supabase
 *    Free rate limit: 100 msg/s) — each candidate is still delivered
 *    individually;
 *  - inbound broadcast frames run through the shared pipeline (chunk
 *    reassembly -> envelope validation -> per-sender reorder for
 *    offer/answer/sfu);
 *  - presence: `channel.track({ id, state, metadata })`; `sync`/`join`/
 *    `leave` events are mapped to `ParticipantPresence` observations.
 *
 * Limits (Free tier): 256 KB broadcast payload, 100 msg/s, 200 concurrent
 * connections. Broadcast has no strict cross-publisher ordering -> the
 * adapter reports `ordering: 'seq-required'` and the reorder buffer is on.
 *
 * See README.md for usage + caveats.
 */
import type { Envelope, PresenceState } from '@vidcall/protocol';
import type { SupabaseClient, RealtimeChannel, RealtimePresenceState } from '@supabase/supabase-js';
import { BaseSignalingTransport, type BaseOptions, type ParticipantInfo, type ParticipantPresence } from '@vidcall/transport';
import { isChunkFrame } from '@vidcall/transport/internal';

export interface SupabaseBackendOptions extends BaseOptions {
  /** Supabase client (create via `createClient(url, anonKey)`). */
  client: SupabaseClient;
  /** Coalesce ICE sends into this window (ms). Default 100. 0 disables. */
  coalesceIceMs?: number;
}

const DEFAULT_ICE_COALESCE_MS = 100;

interface TrackedPresence {
  id: string;
  state: PresenceState;
  metadata?: Record<string, unknown>;
  displayName?: string;
  [key: string]: unknown;
}

export class SupabaseBackend extends BaseSignalingTransport {
  readonly name = 'supabase';
  readonly ordering = 'seq-required' as const;
  readonly maxPayloadBytes = 256 * 1024; // Free tier broadcast cap

  private readonly client: SupabaseClient;
  private channel: RealtimeChannel | null = null;

  constructor(opts: SupabaseBackendOptions) {
    super(
      {
        doJoin: () => this.doJoin(),
        doLeave: () => this.doLeave(),
        doSendFrame: (frame) => this.doSendFrame(frame),
        doSetPresence: (state, metadata) => this.doSetPresence(state, metadata),
        doDispose: async () => this.doDispose(),
      },
      { ...opts, coalesceIceMs: opts.coalesceIceMs ?? DEFAULT_ICE_COALESCE_MS },
    );
    this.client = opts.client;
  }

  // ------------------------------------------------------------- SDK hooks
  private async doJoin(): Promise<void> {
    const room = this.currentRoom;
    const self = this.self;
    if (room === null || self === null) return;
    const channel = this.client.channel(room);
    this.channel = channel;

    // broadcast: every event type
    channel.on('broadcast', { event: '*' }, (msg: { event: string; payload: unknown }) => {
      this.deliverFrame(msg.payload);
    });

    // presence: sync / join / leave -> ParticipantPresence events
    channel.on('presence', { event: 'sync' }, () => this.emitPresenceSnapshot());
    channel.on('presence', { event: 'join' }, (payload: { key: string; newPresences: TrackedPresence[] }) => {
      this.emitPresencePayload(payload.newPresences, 'online');
    });
    channel.on('presence', { event: 'leave' }, (payload: { key: string; leftPresences: TrackedPresence[] }) => {
      // a peer that left is offline regardless of its last tracked state
      for (const entry of payload.leftPresences) {
        if (entry && typeof entry.id === 'string') {
          this.deliverPresence({ participantId: entry.id, state: 'offline', metadata: entry.metadata });
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status: string, err?: Error) => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(err ?? new Error(`supabase channel ${status}`));
        }
      });
    });
  }

  private async doLeave(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (!channel) return;
    await channel.unsubscribe();
    await channel.untrack();
  }

  private async doSendFrame(frame: unknown): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new Error('supabase: not joined');
    const event = isChunkFrame(frame) ? 'chunk' : (frame as Envelope).type;
    const res = await channel.send({ type: 'broadcast', event, payload: frame });
    if (res !== 'ok') throw new Error(`supabase broadcast failed: ${res}`);
  }

  private async doSetPresence(state: PresenceState, metadata?: Record<string, unknown>): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    const tracked: TrackedPresence = {
      id: this.self?.id ?? '',
      state,
      metadata,
      displayName: this.self?.displayName,
      ts: Date.now(),
    };
    await channel.track(tracked);
  }

  private async doDispose(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      await this.client.removeChannel(channel);
    }
  }

  // ------------------------------------------------------------ presence map
  private emitPresenceSnapshot(): void {
    const channel = this.channel;
    if (!channel) return;
    const state: RealtimePresenceState = channel.presenceState() as RealtimePresenceState;
    for (const entries of Object.values(state)) {
      for (const entry of entries as unknown as TrackedPresence[]) {
        if (typeof entry?.id === 'string' && typeof entry?.state === 'string') {
          this.deliverPresence({ participantId: entry.id, state: entry.state, metadata: entry.metadata });
        }
      }
    }
  }

  private emitPresencePayload(payload: TrackedPresence | TrackedPresence[], fallbackState: PresenceState): void {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue;
      const state: PresenceState =
        typeof entry.state === 'string' &&
        ['online', 'away', 'busy', 'offline'].includes(entry.state)
          ? (entry.state as PresenceState)
          : fallbackState;
      this.deliverPresence({ participantId: entry.id, state, metadata: entry.metadata });
    }
  }
}
