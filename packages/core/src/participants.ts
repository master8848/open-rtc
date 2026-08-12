/**
 * Participant & track publication models (public API surface).
 */
import type { DeviceProfile, JoinCapabilities, PresenceState } from '@vidcall/protocol';

export type TrackSource = 'camera' | 'microphone' | 'screen' | 'custom';

export interface TrackPublication {
  /** Stable id (track.id when available, else generated). */
  readonly id: string;
  readonly kind: 'audio' | 'video';
  readonly source: TrackSource;
  readonly participantId: string;
  readonly isLocal: boolean;
  /** Live track; null once unpublished/ended. */
  track: MediaStreamTrack | null;
  muted: boolean;
  /** Extra app data. */
  metadata?: Record<string, unknown>;
}

export interface ParticipantOptions {
  id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  deviceProfile?: DeviceProfile;
  capabilities?: JoinCapabilities;
}

export class LocalParticipant {
  readonly id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  deviceProfile?: DeviceProfile;
  capabilities?: JoinCapabilities;
  private readonly publicationsById = new Map<string, TrackPublication>();

  constructor(options: ParticipantOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.metadata = options.metadata;
    this.deviceProfile = options.deviceProfile;
    this.capabilities = options.capabilities;
  }

  get publications(): TrackPublication[] {
    return [...this.publicationsById.values()];
  }

  getPublication(id: string): TrackPublication | undefined {
    return this.publicationsById.get(id);
  }

  addPublication(publication: TrackPublication): void {
    this.publicationsById.set(publication.id, publication);
  }

  removePublication(id: string): TrackPublication | undefined {
    const pub = this.publicationsById.get(id);
    if (pub) this.publicationsById.delete(id);
    return pub;
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = metadata;
  }
}

export class RemoteParticipant {
  readonly id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  deviceProfile?: DeviceProfile;
  capabilities?: JoinCapabilities;
  /** Backend/room presence state. */
  presence: PresenceState = 'offline';
  /** Peer connection aggregate state for this participant. */
  connectionState: RTCPeerConnectionState | 'new' = 'new';
  readonly joinedAt: number = Date.now();
  private readonly publicationsById = new Map<string, TrackPublication>();

  constructor(options: ParticipantOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.metadata = options.metadata;
    this.deviceProfile = options.deviceProfile;
    this.capabilities = options.capabilities;
  }

  get publications(): TrackPublication[] {
    return [...this.publicationsById.values()];
  }

  getPublication(id: string): TrackPublication | undefined {
    return this.publicationsById.get(id);
  }

  addPublication(publication: TrackPublication): void {
    this.publicationsById.set(publication.id, publication);
  }

  removePublication(id: string): TrackPublication | undefined {
    const pub = this.publicationsById.get(id);
    if (pub) this.publicationsById.delete(id);
    return pub;
  }

  /** Merge info from a join/presence envelope. */
  update(
    info: Partial<
      Pick<ParticipantOptions, 'displayName' | 'metadata' | 'deviceProfile' | 'capabilities'>
    >,
  ): void {
    if (info.displayName !== undefined) this.displayName = info.displayName;
    if (info.metadata !== undefined) this.metadata = info.metadata;
    if (info.deviceProfile !== undefined) this.deviceProfile = info.deviceProfile;
    if (info.capabilities !== undefined) this.capabilities = info.capabilities;
  }
}
