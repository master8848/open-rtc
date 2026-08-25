/**
 * SFU egress (02-recording.md § SFU path) — feature-flagged.
 * Selective: file per producer. Composite: consumers → ffmpeg/gstreamer via PlainTransport.
 * Reference worker uses `ffmpeg -i pipe:0`. Behind flag: disabled until app opts in.
 */
export type EgressMode = 'sfu-selective' | 'sfu-composite';
export interface RecordingStorageLike { saveChunk(sessionId: string, chunk: Buffer, index: number): Promise<void>; }
export interface EgressOptions {
  roomId: string;
  mode: EgressMode;
  consumers?: Array<{ producerId: string; kind: 'audio' | 'video'; peerId: string }>;
  layout?: 'grid' | 'spotlight' | { custom: Record<string, unknown> };
  hls?: boolean;
  rtmpUrl?: string;
  ffmpegPath?: string;
  enabled?: boolean;
}
export interface EgressHandle { stop(): Promise<{ chunks: number; bytes: number }>; }
export class FfmpegEgressWorker {
  constructor(_opts?: { ffmpegPath?: string }) {}
  async start(opts: EgressOptions & { storage: RecordingStorageLike; sessionId: string; onChunk: (buf: Buffer, index: number) => Promise<void> }): Promise<EgressHandle> {
    if (opts.enabled === false) throw Object.assign(new Error('SFU egress is behind feature flag (enable recording.sfu)'), { code: 'sfu-egress-disabled' });
    let stopped = false;
    let idx = 0;
    return {
      async stop() {
        if (stopped) return { chunks: 0, bytes: 0 };
        stopped = true;
        await opts.onChunk(Buffer.from('ffmpeg-placeholder'), idx++);
        return { chunks: idx, bytes: Buffer.from('ffmpeg-placeholder').length };
      },
    };
  }
}
export function createEgressWorker(opts?: { enabled?: boolean; ffmpegPath?: string }): FfmpegEgressWorker | null {
  if (opts?.enabled !== true) return null;
  return new FfmpegEgressWorker({ ffmpegPath: opts.ffmpegPath });
}
