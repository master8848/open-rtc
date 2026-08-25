/**
 * IceCoalescer — batch trickle-ICE envelope sends into a short window.
 *
 * Trickle ICE arrives in bursts (10–50 candidates per session). Rate-limited
 * backends (Supabase Free: 100 msg/s; Appwrite: metered message volume) prefer
 * a handful of batched transport calls over a burst. Each envelope is still
 * delivered individually — coalescing only batches the backend calls.
 */
import type { Envelope } from '@mbsks/protocol';

export interface IceCoalescerOptions {
  /** coalescing window in ms. Default 100. */
  windowMs?: number;
  /** max items to hold before forcing a flush. Default 200. */
  maxItems?: number;
  /** called with the batch of envelopes when flushed. */
  onFlush: (items: Envelope[]) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

export class IceCoalescer {
  private queue: Envelope[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private readonly windowMs: number;
  private readonly maxItems: number;
  private readonly onFlush: (items: Envelope[]) => void | Promise<void>;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: IceCoalescerOptions) {
    this.windowMs = opts.windowMs ?? 100;
    this.maxItems = opts.maxItems ?? 200;
    this.onFlush = opts.onFlush;
    this.onError = opts.onError;
  }

  /** Queue an ICE envelope for batched delivery. */
  push(envelope: Envelope): void {
    this.queue.push(envelope);
    if (this.queue.length >= this.maxItems) {
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.windowMs);
      this.timer.unref?.();
    }
  }

  /** Number of queued items. */
  get size(): number {
    return this.queue.length;
  }

  /** Immediately flush queued items (await completion). */
  async flush(): Promise<void> {
    if (this.flushing) return;
    const items = this.queue;
    if (items.length === 0) return;
    this.flushing = true;
    this.queue = [];
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await this.onFlush(items);
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.flushing = false;
    }
  }

  /** Cancel pending flush + drop queued items. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }
}
