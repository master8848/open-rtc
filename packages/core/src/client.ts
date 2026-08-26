/**
 * VidcallClient — facade over `Room` (Phase 1.1).
 *
 * Hides `RoomConfig` sprawl (18 fields) behind a single-object `connect()` that
 * takes the common subset: `roomId`, `token`, `transport`, `publishDefaults`,
 * `rtc`, `sfu`, `recording`. All other `RoomConfig` fields remain reachable via
 * spread but the facade is the recommended entry point (docs/examples should use it).
 *
 * ```ts
 * const room = await VidcallClient.connect({
 *   roomId: 'demo',
 *   token: 'jwt...',
 *   transport: new SupabaseBackend({ client }),
 *   publishDefaults: { simulcast: true },
 * });
 * // or instance:
 * const client = new VidcallClient({ transport: fallback });
 * const room2 = await client.connect({ roomId, token });
 * ```
 */

import { Room } from './room.ts';
import type { RoomConfig, RoomPublishDefaults, RoomRtcOptions, RoomSfuOptions } from './room.ts';
import type { SignalingTransport } from './transport.ts';

export interface VidcallClientOptions {
  /** Default transport when `connect()` is called without an explicit transport. */
  transport?: SignalingTransport | SignalingTransport[];
  /** Default token applied to `auth.token` when `connect()` omits `token`. */
  token?: string;
}

export interface VidcallConnectOptions {
  roomId: string;
  selfId?: string;
  displayName?: string;
  /** Auth token — mapped to `RoomConfig.auth.token`. */
  token?: string;
  transport: SignalingTransport | SignalingTransport[];
  publishDefaults?: RoomPublishDefaults;
  rtc?: RoomRtcOptions;
  sfu?: RoomSfuOptions;
  recording?: RoomConfig['recording'];
  /** Pass-through for advanced `RoomConfig` fields (quality, e2ee, devices, etc). */
  configOverrides?: Partial<Omit<RoomConfig, 'roomId' | 'selfId' | 'transport' | 'publishDefaults' | 'rtc' | 'sfu' | 'recording'>>;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildRoomConfig(opts: VidcallConnectOptions, defaults: VidcallClientOptions = {}): RoomConfig {
  const transport = opts.transport ?? defaults.transport;
  if (!transport) throw new Error('VidcallClient.connect: transport is required');
  const token = opts.token ?? defaults.token;
  const selfId = opts.selfId ?? randomId();
  const cfg: RoomConfig = {
    roomId: opts.roomId,
    selfId,
    transport,
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.publishDefaults ? { publishDefaults: opts.publishDefaults } : {}),
    ...(opts.rtc ? { rtc: opts.rtc } : {}),
    ...(opts.sfu ? { sfu: opts.sfu } : {}),
    ...(opts.recording ? { recording: opts.recording } : {}),
    ...(token ? { auth: { token } } : {}),
    ...(opts.configOverrides ?? {}),
  };
  // Merge token into auth if overrides also provided auth.
  if (token && opts.configOverrides?.auth) {
    cfg.auth = { ...opts.configOverrides.auth, token } as unknown as RoomConfig['auth'];
  }
  return cfg;
}

export class VidcallClient {
  private readonly defaults: VidcallClientOptions;

  constructor(defaults: VidcallClientOptions = {}) {
    this.defaults = defaults;
  }

  /** Create and join a `Room` in one call. */
  static async connect(options: VidcallConnectOptions): Promise<Room> {
    const cfg = buildRoomConfig(options);
    const room = new Room(cfg);
    await room.join();
    return room;
  }

  /** Instance variant that merges constructor defaults. */
  async connect(options: VidcallConnectOptions): Promise<Room> {
    const cfg = buildRoomConfig(options, this.defaults);
    const room = new Room(cfg);
    await room.join();
    return room;
  }

  /** Build a `Room` without joining (for manual lifecycle). */
  static createRoom(options: VidcallConnectOptions): Room {
    return new Room(buildRoomConfig(options));
  }

  createRoom(options: VidcallConnectOptions): Room {
    return new Room(buildRoomConfig(options, this.defaults));
  }
}
