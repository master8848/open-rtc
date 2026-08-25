import { TypedEmitter } from '../events.ts';

export type ActiveSpeakerEventMap = { 'active-speaker': [string[]] };

export interface ActiveSpeakerOptions {
  getPeerConnections: () => RTCPeerConnection[];
  participantIds: () => string[];
  intervalMs?: number;
  threshold?: number;
}

export class ActiveSpeakerDetector extends TypedEmitter<ActiveSpeakerEventMap> {
  private readonly getPcs: () => RTCPeerConnection[];
  private readonly participantIds: () => string[];
  private readonly intervalMs: number;
  private readonly threshold: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: string[] = [];

  constructor(opts: ActiveSpeakerOptions) {
    super();
    this.getPcs = opts.getPeerConnections;
    this.participantIds = opts.participantIds;
    this.intervalMs = opts.intervalMs ?? 300;
    this.threshold = opts.threshold ?? 0.3;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sample(); }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<void> {
    const pcs = this.getPcs();
    const ids = this.participantIds();
    const speaking: string[] = [];
    for (let i = 0; i < pcs.length; i++) {
      const pc = pcs[i]!;
      const id = ids[i] ?? `pc-${i}`;
      try {
        const stats = await pc.getStats();
        for (const s of stats.values()) {
          if ((s as unknown as { type?: string }).type === 'inbound-rtp' && (s as unknown as { kind?: string }).kind === 'audio') {
            const level = (s as unknown as { audioLevel?: number }).audioLevel;
            if (typeof level === 'number' && level > this.threshold) speaking.push(id);
          }
        }
      } catch { /* ignore */ }
    }
    if (speaking.join(',') !== this.active.join(',')) {
      this.active = speaking;
      this.emit('active-speaker', [...speaking]);
    }
  }
}
