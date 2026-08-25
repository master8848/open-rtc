/**
 * Webhooks — signed POST with HMAC + retry.
 *
 * `services.webhooks = [{ url, secret, events }]` — HMAC `X-Vidcall-Signature`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookConfig {
  url: string;
  secret: string;
  events: Array<'join' | 'leave' | 'recording.finalized' | 'transcript.final' | 'transcript.interim' | 'lobby.waiting' | 'transcript' | 'lobby.waiting'>;
}

export interface WebhookEvent {
  event: string;
  roomId: string;
  payload: unknown;
  ts: number;
}

export function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export async function dispatchWebhook(cfg: WebhookConfig, evt: WebhookEvent, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!cfg.events.includes(evt.event as never)) return;
  const body = JSON.stringify(evt);
  const sig = signBody(body, cfg.secret);
  await fetchImpl(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vidcall-signature': sig },
    body,
  });
}

export async function dispatchWebhooks(configs: WebhookConfig[] | undefined, evt: WebhookEvent, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!configs?.length) return;
  await Promise.all(configs.map((c) => dispatchWebhook(c, evt, fetchImpl).catch(() => {})));
}

export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = signBody(body, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
