/**
 * vidcall React example — `Room` wired to the Supabase backend through the
 * `@mbsks/react` hooks.
 *
 * The vidcall packages are consumed through the monorepo workspace (file:
 * deps in package.json), exactly the "unpublished" install path from the
 * root README. UI state comes from the room snapshot (useRoomState /
 * useParticipants) instead of hand-wired emitter callbacks; only truly
 * imperative things stay event-driven (`track` attachment to <video>,
 * quality-warning toasts).
 *
 * StrictMode safety: the Room is created once with a stable per-page selfId,
 * and joining goes through `useJoin`, which aborts an in-flight join on
 * unmount and defers the leave so a `<StrictMode>` mount → unmount → mount
 * cycle neither leaks a half-joined session nor closes the surviving room.
 *
 * Run: cp .env.example .env (fill Supabase URL + anon key), then
 * `npm install && npm run dev` in this folder.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Room, type TrackPublication } from '@mbsks/core';
import { SupabaseBackend } from '@mbsks/backend-supabase';
import { useJoin, useParticipants, useRoomState } from '@mbsks/react';

interface QualityEvent {
  id: number;
  from: string;
  to: string;
  reason: string;
  direction: string;
  at: string;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const hasSupabase = Boolean(url && anonKey);

// One identity per page load: <StrictMode> remounts reuse it, so a remounted
// room never shows up as a ghost second participant.
const selfId = `user-${Math.random().toString(36).slice(2, 8)}`;

let nextQualityId = 0;

export function App(): JSX.Element {
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create the Room once; teardown on final unmount. The join lifecycle
  // itself belongs to `useJoin` inside <Call>.
  useEffect(() => {
    if (!hasSupabase) {
      setError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in examples/react/.env');
      return;
    }
    const supabase = createClient(url!, anonKey!);
    const nextRoom = new Room({
      roomId: new URLSearchParams(location.search).get('room') ?? 'demo-room',
      selfId,
      displayName: `Guest-${selfId.slice(-4)}`,
      transport: new SupabaseBackend({ client: supabase }),
    });
    nextRoom.on('error', (err) => setError(err.message));
    setRoom(nextRoom);
    return () => {
      setRoom(null);
      void nextRoom.leave();
    };
  }, []);

  return (
    <main style={{ maxWidth: 900, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>vidcall · React example</h1>
      {!hasSupabase && <p style={{ color: '#b00' }}>{error}</p>}
      <p>
        Room: <code>demo-room</code> — open this app in two browser tabs (or two devices) with the
        same Supabase project to make a call.
      </p>
      {room ? (
        <Call room={room} onError={setError} />
      ) : (
        !hasSupabase && <p>Configure the .env file above, then reload.</p>
      )}
    </main>
  );
}

function Call({ room, onError }: { room: Room; onError: (message: string) => void }): JSX.Element {
  // Auto-join on mount; StrictMode-safe (abort on unmount, deferred leave).
  useJoin(room, { onError: (err) => onError(err.message) });
  const snapshot = useRoomState(room);
  const participants = useParticipants(room);

  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraPubRef = useRef<TrackPublication | null>(null);
  const remoteVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const selfVideoRef = useRef<HTMLVideoElement | null>(null);

  const [micMuted, setMicMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [qualityEvents, setQualityEvents] = useState<QualityEvent[]>([]);

  const pushQualityEvent = useCallback(
    (from: string, to: string, reason: string, direction: string) => {
      setQualityEvents((prev) =>
        [
          { id: nextQualityId++, from, to, reason, direction, at: new Date().toLocaleTimeString() },
          ...prev,
        ].slice(0, 20),
      );
    },
    [],
  );

  // Imperative wiring that does not belong in a snapshot: remote tracks onto
  // their tiles, quality warnings into the toast list.
  useEffect(() => {
    const onTrack = ({
      participant,
      track,
    }: {
      participant: { id: string };
      track: MediaStreamTrack;
    }) => {
      const video = remoteVideosRef.current.get(participant.id);
      if (!video) return; // the tile renders from the roster; stream fills in below
      const stream = (video.srcObject as MediaStream | null) ?? new MediaStream();
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      video.srcObject = stream;
    };
    const onQualityWarning = (e: { from: string; to: string; reason: string; direction: string }) =>
      pushQualityEvent(e.from, e.to, e.reason, e.direction);
    room.on('track', onTrack);
    room.on('quality-warning', onQualityWarning);
    return () => {
      room.off('track', onTrack);
      room.off('quality-warning', onQualityWarning);
    };
  }, [room, pushQualityEvent]);

  const joined = snapshot.status === 'joined';

  const toggleCamera = useCallback(async () => {
    if (cameraPubRef.current) {
      await room.unpublish(cameraPubRef.current);
      cameraPubRef.current = null;
      if (selfVideoRef.current) selfVideoRef.current.srcObject = null;
      setCameraOn(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (selfVideoRef.current) selfVideoRef.current.srcObject = stream;
    cameraPubRef.current = await room.publish(stream.getVideoTracks()[0]!, {
      source: 'camera',
    });
    setCameraOn(true);
  }, [room]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setMicMuted((muted) => {
      const next = !muted;
      for (const track of stream.getAudioTracks()) track.enabled = !next;
      return next;
    });
  }, []);

  const videoRefFor = (participantId: string) => (el: HTMLVideoElement | null) => {
    if (el) remoteVideosRef.current.set(participantId, el);
    else remoteVideosRef.current.delete(participantId);
  };

  return (
    <>
      <div style={{ marginBottom: '0.5rem' }}>
        <button
          onClick={() => void room.join().catch((err: Error) => onError(err.message))}
          disabled={snapshot.status !== 'new'}
        >
          {snapshot.status === 'joining' ? 'Joining…' : 'Join'}
        </button>
        <button onClick={() => void toggleCamera()} disabled={!joined}>
          {cameraOn ? 'Camera off' : 'Camera on'}
        </button>
        <button onClick={toggleMic} disabled={!joined}>
          {micMuted ? 'Unmute' : 'Mute'}
        </button>
        <button onClick={() => void room.leave()} disabled={!joined}>
          Leave
        </button>
      </div>

      <section style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0' }}>
        <video ref={selfVideoRef} autoPlay playsInline muted style={videoStyle} />
        {participants.map((p) => (
          <video key={p.id} ref={videoRefFor(p.id)} autoPlay playsInline style={videoStyle} />
        ))}
      </section>

      <h2>Quality events</h2>
      <ul>
        {qualityEvents.length === 0 && (
          <li>No quality changes yet — quality warnings from the wire land here.</li>
        )}
        {qualityEvents.map((e) => (
          <li key={e.id}>
            {e.at} · {e.from} → {e.to} · {e.reason} · {e.direction}
          </li>
        ))}
      </ul>

      <h2>Participants ({participants.length})</h2>
      <ul>
        {participants.map((p) => (
          <li key={p.id}>
            {p.displayName ?? p.id} — {p.presence} ({p.connectionState})
          </li>
        ))}
      </ul>
    </>
  );
}

const videoStyle: CSSProperties = {
  width: 200,
  aspectRatio: '16 / 9',
  background: '#000',
  borderRadius: 8,
};
