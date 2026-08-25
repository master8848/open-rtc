/**
 * Push notifications — FCM/APNs via app-provided keys; trigger on `join` when participant offline.
 * Isolated subpath so core has no push SDK dep.
 */

export interface PushConfig {
  fcmServerKey?: string;
  apnsKeyId?: string;
  apnsTeamId?: string;
}

export interface PushToken {
  participantId: string;
  token: string;
  platform: 'fcm' | 'apns';
}

export interface PushService {
  register(token: PushToken): Promise<void>;
  notify(roomId: string, payload: unknown): Promise<void>;
}

export class InMemoryPushService implements PushService {
  private tokens = new Map<string, PushToken>();
  readonly sent: Array<{ roomId: string; payload: unknown }> = [];

  async register(token: PushToken): Promise<void> {
    this.tokens.set(token.participantId, token);
  }

  async notify(roomId: string, payload: unknown): Promise<void> {
    this.sent.push({ roomId, payload });
  }

  getToken(participantId: string): PushToken | undefined {
    return this.tokens.get(participantId);
  }
}
