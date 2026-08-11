/**
 * Heartbeat + presence sweeper — for backends with no native disconnect
 * signal (Postgres, Appwrite) and for in-memory/test use.
 *
 * - Heartbeat: calls `onBeat` every `intervalMs` (default 5 s) so presence
 *   rows / NOTIFYs stay fresh.
 * - PresenceSweeper: given lastSeen timestamps, emits `onStale` for peers
 *   that haven't been seen for `timeoutMs`. Adapters use this to drop
 *   dead peers from their presence snapshot (no onDisconnect equivalent).
 */
export interface HeartbeatOptions {
  intervalMs?: number;
  /** called on every beat; errors are swallowed and logged. */
  onBeat: () => void | Promise<void>;
  onError?: (err: unknown) => void;
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly onBeat: () => void | Promise<void>;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: HeartbeatOptions) {
    this.intervalMs = opts.intervalMs ?? 5000;
    this.onBeat = opts.onBeat;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void (async () => {
        try {
          await this.onBeat();
        } catch (err) {
          this.onError?.(err);
        }
      })();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }
}

export interface PresenceSweeperOptions {
  /** a peer is stale when now - lastSeen > timeoutMs. */
  timeoutMs: number;
  /** called with the stale peer id (adapter removes it from its snapshot). */
  onStale: (id: string) => void;
}

/**
 * Tracks lastSeen per peer id and detects stale peers. `touch` is called on
 * every inbound presence/heartbeat; `sweep` is called on a timer.
 */
export class PresenceSweeper {
  private lastSeen = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly onStale: (id: string) => void;

  constructor(opts: PresenceSweeperOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.onStale = opts.onStale;
  }

  touch(id: string, now = Date.now()): void {
    this.lastSeen.set(id, now);
  }

  /** Returns ids that went stale in this sweep. */
  sweep(now = Date.now()): string[] {
    const stale: string[] = [];
    for (const [id, seen] of this.lastSeen) {
      if (now - seen > this.timeoutMs) {
        stale.push(id);
        this.lastSeen.delete(id);
      }
    }
    for (const id of stale) this.onStale(id);
    return stale;
  }

  remove(id: string): void {
    this.lastSeen.delete(id);
  }

  /** Forget every tracked peer (e.g. on leave). */
  removeAll(): void {
    this.lastSeen.clear();
  }

  /** convenience: start sweeping on an interval. */
  start(intervalMs: number): () => void {
    const t = setInterval(() => this.sweep(), intervalMs);
    t.unref?.();
    return () => clearInterval(t);
  }
}
