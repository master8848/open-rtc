/**
 * Webhooks — signed POST with HMAC + retry.
 *
 * `services.webhooks = [{ url, secret, events }]` — HMAC `X-Vidcall-Signature`.
 */

import { createHmac } from 'node:crypto';

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
  // constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
