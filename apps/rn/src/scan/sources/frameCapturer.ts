/**
 * Photo → {@linkcode CameraFrame} (card A4).
 *
 * Kept apart from ./native so it can be tested without loading ML Kit: the VisionCamera v5
 * `CameraPhotoOutput`/`Photo` surface is typed structurally here, and a fake photo output is enough
 * to pin down the important behaviour (JPEG bytes + file path + dispose, even on failure).
 */
import {arrayBufferToBase64} from './base64';
import type {CameraFrame} from './types';

/** The parts of VisionCamera v5's `Photo` this module needs. */
export interface PhotoLike {
  readonly width: number;
  readonly height: number;
  /** Seconds on the host clock. */
  readonly timestamp: number;
  getFileDataAsync(): Promise<ArrayBuffer>;
  saveToTemporaryFileAsync(): Promise<string>;
  dispose(): void;
}

/** The parts of VisionCamera v5's `CameraPhotoOutput` this module needs. */
export interface PhotoOutputLike {
  capturePhoto(
    settings: {flashMode?: 'off' | 'on' | 'auto'; enableShutterSound?: boolean},
    callbacks: Record<string, never>,
  ): Promise<PhotoLike>;
}

export interface FrameCapturerOptions {
  /** Override for tests; defaults to the photo's own capture timestamp. */
  now?: () => number;
}

/**
 * Build the `capture()` function for the capture loop: one JPEG per call as
 * `{jpegBase64, filePath, width, height, capturedAt}`.
 *
 * `Photo.dispose()` is mandatory in VisionCamera v5 (the JS object holds native memory), so the
 * photo is always disposed, even when reading the bytes fails.
 *
 * Note: `saveToTemporaryFileAsync()` leaves one JPEG per sampled frame in the app cache directory
 * (~100–200 KB at 2.5 fps); Android clears that cache, and the scan screen is only open while
 * scanning. A cleanup hook would need a file-system module, which this card does not own (see
 * kanban Notes).
 */
export function createFrameCapturer(
  photoOutput: PhotoOutputLike,
  {now = Date.now}: FrameCapturerOptions = {},
): () => Promise<CameraFrame> {
  return async () => {
    const photo = await photoOutput.capturePhoto(
      {flashMode: 'off', enableShutterSound: false},
      {},
    );
    try {
      const data = await photo.getFileDataAsync();
      const filePath = await photo.saveToTemporaryFileAsync();
      const photoTimestamp = photo.timestamp * 1000;
      return {
        jpegBase64: arrayBufferToBase64(data),
        filePath,
        width: photo.width,
        height: photo.height,
        capturedAt:
          Number.isFinite(photoTimestamp) && photoTimestamp > 0
            ? Math.round(photoTimestamp)
            : now(),
      };
    } finally {
      photo.dispose();
    }
  };
}
