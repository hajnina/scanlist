/**
 * Rear-camera access (card C4): `getUserMedia` + the browser's error taxonomy.
 *
 * Two hard web facts drive this module:
 *  - `navigator.mediaDevices` is **undefined** outside a secure context, so `http://<lan-ip>:5173`
 *    fails on a phone with a bare `TypeError` — the card's "Chrome on Android over HTTPS" is C6's
 *    job, and the UI should be able to say *why* the camera did not open.
 *  - constraint negotiation is the browser's, not ours: `facingMode: {ideal: 'environment'}` asks
 *    for the rear camera without failing on a laptop that only has a webcam (the documented
 *    desktop fallback for this card).
 *
 * Everything here is injected (`mediaDevices`), so happy-dom can test the decision logic without a
 * camera.
 */

export interface CameraError extends Error {
  code:
    | 'insecure-context'
    | 'unsupported'
    | 'denied'
    | 'not-found'
    | 'in-use'
    | 'constraint'
    | 'unknown';
  /** The original DOMException/TypeError, for console diagnostics. */
  cause?: unknown;
}

function cameraError(code: CameraError['code'], message: string, cause?: unknown): CameraError {
  const error = new Error(message) as CameraError;
  error.name = 'CameraError';
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** Rear camera if the device has one, otherwise whatever camera exists (desktop webcam). */
export function rearCameraConstraints(overrides: MediaTrackConstraintSet = {}): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      ...overrides,
    },
  };
}

/** The slice of `navigator.mediaDevices` this module needs (injected for tests). */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface CameraEnvironment {
  mediaDevices?: MediaDevicesLike;
  /** `window.isSecureContext`; defaults to the global when available. */
  isSecureContext?: boolean;
}

function resolveEnvironment(env: CameraEnvironment): CameraEnvironment {
  if (env.mediaDevices !== undefined || env.isSecureContext !== undefined) return env;
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    mediaDevices: nav?.mediaDevices as MediaDevicesLike | undefined,
    isSecureContext: typeof window === 'undefined' ? undefined : window.isSecureContext,
  };
}

/**
 * Open the rear camera. Throws a {@linkcode CameraError} with a stable `code` the UI can map to
 * copy; never returns a stream the caller has to validate.
 */
export async function openRearCamera(
  env: CameraEnvironment = {},
  constraints: MediaStreamConstraints = rearCameraConstraints(),
): Promise<MediaStream> {
  const resolved = resolveEnvironment(env);
  if (resolved.isSecureContext === false) {
    throw cameraError(
      'insecure-context',
      'the camera needs a secure context: open the app over HTTPS (or localhost)',
    );
  }
  if (resolved.mediaDevices === undefined) {
    throw cameraError(
      'unsupported',
      'this browser does not expose navigator.mediaDevices.getUserMedia',
    );
  }
  try {
    return await resolved.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    throw classifyCameraError(error);
  }
}

/** Map a DOMException from `getUserMedia` to the UI-facing code (name strings, not instances). */
export function classifyCameraError(error: unknown): CameraError {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return cameraError('denied', 'camera permission was denied', error);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return cameraError('not-found', 'no camera matches the requested constraints', error);
    case 'NotReadableError':
    case 'AbortError':
      return cameraError('in-use', 'the camera is already in use by another app or tab', error);
    case 'TypeError':
      return cameraError(
        'constraint',
        'the browser rejected the camera constraints',
        error,
      );
    default:
      return cameraError(
        'unknown',
        error instanceof Error ? error.message : 'could not open the camera',
        error,
      );
  }
}

/** Stop every track — call on unmount/stop, or the camera LED stays on. */
export function stopStream(stream: MediaStream | undefined): void {
  if (stream === undefined) return;
  for (const track of stream.getTracks()) track.stop();
}
