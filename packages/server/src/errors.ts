/**
 * @vidcall/server — typed error model.
 *
 * Every failure surfaced by the core functions and HTTP/WS layer is a
 * `VidcallError` with a stable machine-readable `code`, a human message,
 * and an HTTP status for the REST layer. Framework adapters map these to
 * their native error responses (Express/Fastify JSON, Django/Laravel/Rails
 * sidecar proxies pass the status + JSON body through verbatim).
 */

export const ERROR_CODES = [
  'room_not_found',
  'room_already_exists',
  'room_closed',
  'room_full',
  'participant_not_found',
  'participant_already_joined',
  'recording_not_found',
  'invalid_envelope',
  'invalid_request',
  'recording_storage_error',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Error thrown by core operations; carries an HTTP status for REST hosting. */
export class VidcallError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'VidcallError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Wire shape: `{ error: { code, message, details? } }`. */
  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    const error: { code: ErrorCode; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** True when `err` is a `VidcallError` (works across realm copies). */
export function isVidcallError(err: unknown): err is VidcallError {
  return (
    err instanceof VidcallError ||
    (isRecord(err) && err.name === 'VidcallError' && typeof err.code === 'string')
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Error factories — one per code, so call sites stay terse. */
export const errors = {
  roomNotFound(roomId: string): VidcallError {
    return new VidcallError('room_not_found', `Room not found: ${roomId}`, 404);
  },
  roomAlreadyExists(roomId: string): VidcallError {
    return new VidcallError('room_already_exists', `Room already exists: ${roomId}`, 409);
  },
  roomClosed(roomId: string): VidcallError {
    return new VidcallError('room_closed', `Room is closed: ${roomId}`, 409);
  },
  roomFull(roomId: string): VidcallError {
    return new VidcallError('room_full', `Room is full: ${roomId}`, 409);
  },
  participantNotFound(roomId: string, participantId: string): VidcallError {
    return new VidcallError(
      'participant_not_found',
      `Participant not in room ${roomId}: ${participantId}`,
      404,
    );
  },
  participantAlreadyJoined(roomId: string, participantId: string): VidcallError {
    return new VidcallError(
      'participant_already_joined',
      `Participant already joined room ${roomId}: ${participantId}`,
      409,
    );
  },
  recordingNotFound(sessionId: string): VidcallError {
    return new VidcallError(
      'recording_not_found',
      `Recording session not found: ${sessionId}`,
      404,
    );
  },
  invalidEnvelope(message: string): VidcallError {
    return new VidcallError('invalid_envelope', message, 400);
  },
  invalidRequest(message: string): VidcallError {
    return new VidcallError('invalid_request', message, 400);
  },
  recordingStorageError(message: string, details?: unknown): VidcallError {
    return new VidcallError('recording_storage_error', message, 500, details);
  },
  internalError(message: string, details?: unknown): VidcallError {
    return new VidcallError('internal_error', message, 500, details);
  },
};
