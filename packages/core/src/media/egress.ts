/**
 * Egress — HLS/RTMP live-stream descriptors (06-advanced-media 1. Ingress/Egress).
 *
 * This module is transport-agnostic: the Room/Server layers call
 * `startEgress`/`stopEgress` on the MediaTransport seam or the gateway;
 * here we provide the option bag, helpers and a minimal `EgressController`
 * that tracks an in-flight egress without touching mediasoup/ffmpeg (infra dep).
 */

export interface EgressOptions {
  hls?: boolean;
  rtmpUrl?: string;
  whep?: boolean;
}

export interface EgressHandle {
  egressId: string;
  roomId: string;
  options: EgressOptions;
  startedAt: number;
  hlsUrl?: string;
  whepUrl?: string;
  stop(): Promise<void>;
}

export class EgressController {
  private running = new Map<string, EgressHandle>();
  private readonly baseHlsUrl?: string;
  private readonly baseWhepUrl?: string;

  constructor(opts: { baseHlsUrl?: string; baseWhepUrl?: string } = {}) {
    this.baseHlsUrl = opts.baseHlsUrl;
    this.baseWhepUrl = opts.baseWhepUrl;
  }

  start(roomId: string, opts: EgressOptions): EgressHandle {
    const egressId = `egress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const hlsUrl = opts.hls ? `${this.baseHlsUrl ?? '/egress/hls'}/${encodeURIComponent(roomId)}/${egressId}/index.m3u8` : undefined;
    const whepUrl = opts.whep ? `${this.baseWhepUrl ?? '/whep'}/${encodeURIComponent(roomId)}` : undefined;
    const handle: EgressHandle = {
      egressId,
      roomId,
      options: opts,
      startedAt,
      ...(hlsUrl ? { hlsUrl } : {}),
      ...(whepUrl ? { whepUrl } : {}),
      stop: async () => { this.running.delete(egressId); },
    };
    this.running.set(egressId, handle);
    return handle;
  }

  stop(roomId: string): void {
    for (const [id, h] of this.running) if (h.roomId === roomId) this.running.delete(id);
  }

  list(roomId: string): EgressHandle[] {
    return [...this.running.values()].filter((h) => h.roomId === roomId);
  }

  get(egressId: string): EgressHandle | undefined {
    return this.running.get(egressId);
  }
}
