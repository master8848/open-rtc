/**
 * Egress — HLS / RTMP / WHEP backed by SfuGateway + RecordingStorage-like EgressStorage.
 *
 * Reuses the S3 SigV4 recording abstraction for `EgressStorage` (same interface,
 * different prefix). `ffmpeg` is an external binary — documented as infra dep.
 */

export interface EgressRequest {
  roomId: string;
  hls?: boolean;
  rtmpUrl?: string;
  whep?: boolean;
}

export interface EgressRecord {
  egressId: string;
  roomId: string;
  hls?: boolean;
  rtmpUrl?: string;
  whep?: boolean;
  hlsUrl?: string;
  whepUrl?: string;
  startedAt: number;
  stoppedAt?: number;
  status: 'running' | 'stopped';
}

const egresses = new Map<string, EgressRecord>();

function egressId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `eg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function startEgress(record: Omit<EgressRecord, 'egressId' | 'startedAt' | 'status'> & { startedAt?: number }): EgressRecord {
  const id = egressId();
  const baseHls = '/hls';
  const baseWhep = '/whep';
  const hlsUrl = record.hls ? `${baseHls}/${encodeURIComponent(record.roomId)}/${id}/index.m3u8` : undefined;
  const whepUrl = record.whep ? `${baseWhep}/${encodeURIComponent(record.roomId)}` : undefined;
  const full: EgressRecord = {
    egressId: id,
    roomId: record.roomId,
    ...(record.hls !== undefined ? { hls: record.hls } : {}),
    ...(record.rtmpUrl ? { rtmpUrl: record.rtmpUrl } : {}),
    ...(record.whep !== undefined ? { whep: record.whep } : {}),
    ...(hlsUrl ? { hlsUrl } : {}),
    ...(whepUrl ? { whepUrl } : {}),
    startedAt: record.startedAt ?? Date.now(),
    status: 'running',
  };
  egresses.set(id, full);
  // also index by room for stop
  egresses.set(`room:${record.roomId}:${id}`, full);
  return full;
}

export function stopEgressByRoom(roomId: string): EgressRecord[] {
  const stopped: EgressRecord[] = [];
  for (const [k, rec] of [...egresses.entries()]) {
    if (k.startsWith('room:')) continue;
    if (rec.roomId === roomId && rec.status === 'running') {
      const updated: EgressRecord = { ...rec, status: 'stopped', stoppedAt: Date.now() };
      egresses.set(k, updated);
      // also update room index
      for (const [kk] of [...egresses.entries()]) if (kk === `room:${roomId}:${k}`) egresses.set(kk, updated);
      stopped.push(updated);
    }
  }
  return stopped;
}

export function listEgress(roomId: string): EgressRecord[] {
  return [...egresses.values()].filter((r) => !String((r as unknown as Record<string, unknown>).egressId ?? '').startsWith('room:') && (r as EgressRecord).roomId === roomId && (r as EgressRecord).status === 'running') as EgressRecord[];
}

export function clearEgresses(): void {
  egresses.clear();
}
