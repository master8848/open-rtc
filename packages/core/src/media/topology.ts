import type { MediaTransport } from './media-transport.ts';

export type Topology = 'mesh' | 'sfu' | 'auto';

export interface TopologyConfig {
  topology?: Topology;
  autoThreshold?: number;
  sfu?: { gateway?: unknown; participantId?: string };
}

export class TopologyController {
  private readonly getParticipantCount: () => number;
  private readonly getTransport: () => MediaTransport;
  private readonly switchTransport: (kind: 'mesh' | 'sfu') => Promise<void>;
  private readonly cfg: Required<TopologyConfig>;
  private readonly debug: (message: string, data?: unknown) => void;

  constructor(opts: {
    config?: TopologyConfig;
    getParticipantCount: () => number;
    getTransport: () => MediaTransport;
    switchTransport: (kind: 'mesh' | 'sfu') => Promise<void>;
    debug: (message: string, data?: unknown) => void;
  }) {
    this.getParticipantCount = opts.getParticipantCount;
    this.getTransport = opts.getTransport;
    this.switchTransport = opts.switchTransport;
    this.debug = opts.debug;
    this.cfg = {
      topology: opts.config?.topology ?? 'auto',
      autoThreshold: opts.config?.autoThreshold ?? 4,
      sfu: opts.config?.sfu ?? {},
    };
  }

  get topology(): Topology { return this.cfg.topology; }
  get autoThreshold(): number { return this.cfg.autoThreshold; }

  shouldBeSfu(): boolean {
    if (this.cfg.topology === 'sfu') return true;
    if (this.cfg.topology === 'mesh') return false;
    return this.getParticipantCount() > this.cfg.autoThreshold;
  }

  desiredKind(): 'mesh' | 'sfu' { return this.shouldBeSfu() ? 'sfu' : 'mesh'; }

  async maybeMigrate(): Promise<void> {
    if (this.cfg.topology !== 'auto') return;
    const desired = this.desiredKind();
    const current = this.getTransport().kind;
    if (current === desired) return;
    if (current === 'mesh' && desired === 'sfu') {
      this.debug('topology:migrate', { from: 'mesh', to: 'sfu', count: this.getParticipantCount() });
      await this.switchTransport('sfu');
    } else if (current === 'sfu' && desired === 'mesh') {
      this.debug('topology:stay-sfu', { count: this.getParticipantCount() });
    }
  }

  async setTopology(topology: Topology): Promise<void> {
    if (topology === this.cfg.topology) return;
    (this.cfg as unknown as { topology: Topology }).topology = topology;
    const desired = this.desiredKind();
    const current = this.getTransport().kind;
    if (desired === current) return;
    await this.switchTransport(desired);
  }
}
