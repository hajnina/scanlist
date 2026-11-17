/**
 * Photo → {@linkcode CameraFrame} (card A4; temp-file lifecycle from card A6).
 *
 * Kept apart from ./native so it can be tested without loading ML Kit: the VisionCamera v5
 * `CameraPhotoOutput`/`Photo` surface is typed structurally here, and a fake photo output is enough
 * to pin down the important behaviour (JPEG bytes + file path + dispose, even on failure).
 *
 * **Temp JPEG.** VisionCamera v5 can only give ML Kit a *file path* for static-image barcode/OCR, so
 * every sampled frame is saved with `saveToTemporaryFileAsync()` (~100–200 KB at 2.5 fps). The frame
 * therefore carries a `release()` that deletes the file through the injected `deleteFile`; the frame
 * feed decides *when* to call it (grace period / camera stop), so the capture path never waits on the
 * file system. The app injects the native `deleteTempFile` (the RN project has no fs dependency, and
 * the A4 review asked for exactly this follow-up).
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
  /**
   * Deletes one temp JPEG the capturer produced (the native `deleteTempFile` in the app). Omit in
   * tests that do not exercise the lifecycle — the frame then has no `release`.
   */
  deleteFile?: (path: string) => void | Promise<void>;
}

/**
 * Build the `capture()` function for the capture loop: one JPEG per call as
 * `{jpegBase64, filePath, width, height, capturedAt, release}`.
 *
 * `Photo.dispose()` is mandatory in VisionCamera v5 (the JS object holds native memory), so the
 * photo is always disposed, even when reading the bytes fails.
 */
export function createFrameCapturer(
  photoOutput: PhotoOutputLike,
  {now = Date.now, deleteFile}: FrameCapturerOptions = {},
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
      const frame: CameraFrame = {
        jpegBase64: arrayBufferToBase64(data),
        filePath,
        width: photo.width,
        height: photo.height,
        capturedAt:
          Number.isFinite(photoTimestamp) && photoTimestamp > 0
            ? Math.round(photoTimestamp)
            : now(),
      };
      if (deleteFile !== undefined) {
        frame.release = () => deleteFile(filePath);
      }
      return frame;
    } finally {
      photo.dispose();
    }
  };
}
