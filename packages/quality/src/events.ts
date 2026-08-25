/**
 * Minimal typed event emitter for the policy engine.
 *
 * Deliberately in-workspace (CONTRIBUTING: small helpers live in-workspace)
 * so `@mbsks/openrtc-quality` stays a standalone pure package with zero runtime
 * dependencies and no WebRTC imports. Mirrors `@mbsks/openrtc-core`'s TypedEmitter.
 */
export type EventMap = Record<string, unknown[]>;

type AnyListener = (...args: unknown[]) => void;

export class TypedEmitter<E extends EventMap = EventMap> {
  private readonly listeners = new Map<keyof E, Set<AnyListener>>();

  /** Register a listener; returns an unsubscribe function. */
  on<K extends keyof E>(event: K, listener: (...args: E[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as unknown as AnyListener);
    return () => this.off(event, listener);
  }

  /** Register a one-shot listener; returns an unsubscribe function. */
  once<K extends keyof E>(event: K, listener: (...args: E[K]) => void): () => void {
    const off = this.on(event, (...args: E[K]) => {
      off();
      listener(...args);
    });
    return off;
  }

  /** Remove a listener (no-op if not registered). */
  off<K extends keyof E>(event: K, listener: (...args: E[K]) => void): void {
    this.listeners.get(event)?.delete(listener as unknown as AnyListener);
  }

  /** Synchronously invoke all listeners for `event`. Returns true if any ran. */
  emit<K extends keyof E>(event: K, ...args: E[K]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    // Snapshot so listeners added/removed during emit don't affect this pass.
    for (const listener of [...set]) {
      listener(...(args as unknown[]));
    }
    return true;
  }

  /** Remove all listeners (optionally for one event only). */
  removeAllListeners(event?: keyof E): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
