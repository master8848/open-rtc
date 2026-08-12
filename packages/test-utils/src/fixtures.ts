/**
 * Test fixtures shared across packages.
 */
import type { Envelope } from '@vidcall/protocol';

let seqCounter = 0;

export interface MakeEnvelopeInput {
  type: Envelope['type'];
  senderId?: string;
  roomId?: string;
  sessionId?: string;
  seq?: number;
  ts?: number;
  targetSenderId?: string;
  payload?: Record<string, unknown>;
}

/** Build a valid wire envelope with monotonic seq/ts defaults. */
export function makeEnvelope(input: MakeEnvelopeInput): Envelope {
  seqCounter += 1;
  return {
    v: 1,
    type: input.type,
    roomId: input.roomId ?? 'room-test',
    senderId: input.senderId ?? 'sender-' + seqCounter,
    sessionId: input.sessionId ?? 'session-' + seqCounter,
    ts: input.ts ?? 1_700_000_000_000 + seqCounter,
    seq: input.seq ?? seqCounter,
    ...(input.targetSenderId !== undefined ? { targetSenderId: input.targetSenderId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  } as Envelope;
}

/** Resolve after `ms` (default 0 = one macrotask). */
export function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` is true (polling every `intervalMs`), or timeout. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const { timeoutMs = 2000, intervalMs = 5, message = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: timed out waiting for ${message}`);
    await sleep(intervalMs);
  }
}

/** Collect events of one type into an array as they fire. */
export function collectEvents<E>(
  emitter: { on: (event: string, cb: (e: E) => void) => unknown },
  event: string,
): E[] {
  const events: E[] = [];
  emitter.on(event, (e: E) => events.push(e));
  return events;
}
