/**
 * Card C4: rear-camera constraints and the getUserMedia error taxonomy.
 *
 * happy-dom has no camera, so the environment is injected: these tests pin the constraints
 * (`facingMode: environment` as *ideal*, so a desktop webcam still opens) and the stable error codes
 * the UI maps to copy — including the HTTPS requirement C6 depends on.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type CameraEnvironment,
  type MediaDevicesLike,
  classifyCameraError,
  openRearCamera,
  rearCameraConstraints,
  stopStream,
} from '../camera';

function fakeStream(tracks: Array<{ stop: () => void }>): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function devicesReturning(stream: MediaStream): { mediaDevices: MediaDevicesLike; getUserMedia: ReturnType<typeof vi.fn> } {
  const getUserMedia = vi.fn(async () => stream);
  return { mediaDevices: { getUserMedia }, getUserMedia };
}

function devicesRejecting(name: string): MediaDevicesLike {
  return {
    getUserMedia: async () => {
      const error = new Error(name);
      error.name = name;
      throw error;
    },
  };
}

describe('rearCameraConstraints', () => {
  it('asks for the rear camera but only as an ideal (desktop webcam fallback)', () => {
    const constraints = rearCameraConstraints();
    expect(constraints.audio).toBe(false);
    const video = constraints.video as MediaTrackConstraints;
    expect(video.facingMode).toEqual({ ideal: 'environment' });
    expect(video.width).toEqual({ ideal: 1280 });
    expect(video.height).toEqual({ ideal: 720 });
  });

  it('lets the caller override individual constraints', () => {
    const video = rearCameraConstraints({ width: { ideal: 1920 } }).video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 1920 });
    expect(video.facingMode).toEqual({ ideal: 'environment' });
  });
});

describe('openRearCamera', () => {
  it('returns the stream from getUserMedia with the requested constraints', async () => {
    const stream = fakeStream([]);
    const { mediaDevices, getUserMedia } = devicesReturning(stream);
    await expect(openRearCamera({ mediaDevices, isSecureContext: true })).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith(rearCameraConstraints());
  });

  it('explains the HTTPS requirement instead of a bare TypeError', async () => {
    const env: CameraEnvironment = { mediaDevices: devicesReturning(fakeStream([])).mediaDevices, isSecureContext: false };
    await expect(openRearCamera(env)).rejects.toMatchObject({
      name: 'CameraError',
      code: 'insecure-context',
      message: expect.stringContaining('HTTPS'),
    });
  });

  it('reports unsupported when navigator.mediaDevices is missing (insecure LAN origin)', async () => {
    await expect(openRearCamera({ mediaDevices: undefined, isSecureContext: true })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('maps permission denial', async () => {
    await expect(
      openRearCamera({ mediaDevices: devicesRejecting('NotAllowedError'), isSecureContext: true }),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('maps no camera / unsatisfiable constraints', async () => {
    for (const name of ['NotFoundError', 'OverconstrainedError']) {
      await expect(
        openRearCamera({ mediaDevices: devicesRejecting(name), isSecureContext: true }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
  });

  it('maps a camera held by another app/tab', async () => {
    for (const name of ['NotReadableError', 'AbortError']) {
      await expect(
        openRearCamera({ mediaDevices: devicesRejecting(name), isSecureContext: true }),
      ).rejects.toMatchObject({ code: 'in-use' });
    }
  });

  it('maps a TypeError from bad constraints', async () => {
    await expect(
      openRearCamera({ mediaDevices: devicesRejecting('TypeError'), isSecureContext: true }),
    ).rejects.toMatchObject({ code: 'constraint' });
  });

  it('keeps the cause and falls back to "unknown" for unrecognised errors', () => {
    const cause = new Error('boom');
    const error = classifyCameraError(cause);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('boom');
    expect(error.cause).toBe(cause);
  });
});

describe('stopStream', () => {
  it('stops every track and tolerates undefined', () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    stopStream(fakeStream([first, second]));
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(() => stopStream(undefined)).not.toThrow();
  });
});
