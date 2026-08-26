import { useEffect, useState } from 'react';
import type { Room, RoomParticipantSnapshot, RoomPublicationSnapshot } from '@mbsks/openrtc-core';

/**
 * One remote track publication by participant id (and optional kind filter).
 * Re-renders only when that participant's publications change (via snapshot
 * subscription, not per-frame track events).
 */
export function useRemoteTrack(
  room: Room,
  participantId: string,
  kind?: 'audio' | 'video',
): RoomPublicationSnapshot | undefined {
  const pick = (snap: ReturnType<Room['getSnapshot']>): RoomPublicationSnapshot | undefined => {
    const p: RoomParticipantSnapshot | undefined = snap.participants.find((pp) => pp.id === participantId);
    if (!p) return undefined;
    const list = kind ? p.publications.filter((pub) => pub.kind === kind) : p.publications;
    return list[0];
  };
  const [pub, setPub] = useState<RoomPublicationSnapshot | undefined>(() => pick(room.getSnapshot()));
  useEffect(() => {
    const check = () => {
      const next = pick(room.getSnapshot());
      setPub((prev) => (prev === next || (prev?.id === next?.id && prev?.track === next?.track && prev?.muted === next?.muted) ? prev : next));
    };
    const offStore = room.store.subscribe(check);
    const offTrack = room.on('track', check as never);
    const offUnpub = room.on('track-unpublished', check as never);
    // Ensure initial sync
    check();
    return () => { offStore(); offTrack(); offUnpub(); };
  }, [room, participantId, kind]);
  return pub;
}

/**
 * All remote publications for a participant (filtered by kind if provided).
 */
export function useRemoteTracks(
  room: Room,
  participantId: string,
  kind?: 'audio' | 'video',
): readonly RoomPublicationSnapshot[] {
  const [pubs, setPubs] = useState<readonly RoomPublicationSnapshot[]>(() => {
    const p = room.getSnapshot().participants.find((pp) => pp.id === participantId);
    if (!p) return [];
    return kind ? p.publications.filter((pub) => pub.kind === kind) : p.publications;
  });
  useEffect(() => {
    const check = () => {
      const p = room.getSnapshot().participants.find((pp) => pp.id === participantId);
      const next = p ? (kind ? p.publications.filter((pub) => pub.kind === kind) : p.publications) : [];
      setPubs((prev) => (prev === next ? prev : next));
    };
    const offStore = room.store.subscribe(check);
    const offTrack = room.on('track', check as never);
    const offUnpub = room.on('track-unpublished', check as never);
    return () => { offStore(); offTrack(); offUnpub(); };
  }, [room, participantId, kind]);
  return pubs;
}
