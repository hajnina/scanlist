/**
 * JPEG frame accounting (card C4).
 *
 * The 384 px JPEG is the only large thing the scan loop sends, so its size is worth accounting for
 * explicitly: the card asks for a 384 px frame, the server caps bodies at 12 MB
 * (`MAX_IMAGE_BYTES`, C1), and a debug chip wants "38 kB × 2.5 fps". These helpers are pure and
 * take a `CapturedFrame`/`Blob`, so happy-dom can exercise them with fake byte arrays.
 */

import { MAX_IMAGE_UPLOAD_BYTES } from './embedder';
import type { CapturedFrame } from './types';

export interface JpegStats {
  /** Encoded JPEG size in bytes (`Blob.size`). */
  bytes: number;
  /** Encoded pixel count (width × height, after the 384 px scale). */
  pixels: number;
  /** Compression achieved: bits per encoded pixel. */
  bitsPerPixel: number;
}

export function jpegStats(frame: Pick<CapturedFrame, 'jpeg' | 'width' | 'height'>): JpegStats {
  const pixels = frame.width * frame.height;
  return {
    bytes: frame.jpeg.size,
    pixels,
    bitsPerPixel: pixels === 0 ? 0 : (frame.jpeg.size * 8) / pixels,
  };
}

/**
 * Why this frame must not be uploaded, or `undefined` when it is fine.
 *
 * Mirrors the server's own checks (empty body → 400, > 12 MB → 413, non-JPEG magic → 400) so a
 * broken canvas (0×0 after a tab switch, a PNG mislabelled by a mock) fails locally with a useful
 * message instead of costing a round trip.
 */
export function frameUploadProblem(frame: CapturedFrame): string | undefined {
  if (frame.width <= 0 || frame.height <= 0) {
    return `frame has no pixels (${frame.width}x${frame.height})`;
  }
  if (frame.jpeg.size === 0) return 'frame JPEG is empty';
  if (frame.jpeg.size > MAX_IMAGE_UPLOAD_BYTES) {
    return `frame JPEG is ${frame.jpeg.size} B, server cap is ${MAX_IMAGE_UPLOAD_BYTES} B`;
  }
  if (frame.jpeg.type !== '' && frame.jpeg.type !== 'image/jpeg') {
    return `frame is ${frame.jpeg.type}, not image/jpeg`;
  }
  return undefined;
}

export interface ByteCounterSnapshot {
  count: number;
  totalBytes: number;
  meanBytes: number;
  maxBytes: number;
}

export interface ByteCounter {
  record(frame: Pick<CapturedFrame, 'jpeg'>): ByteCounterSnapshot;
  snapshot(): ByteCounterSnapshot;
  reset(): void;
}

/** Rolling "how big are our frames / how much have we sent" counter for the scan debug chip. */
export function createByteCounter(): ByteCounter {
  let count = 0;
  let totalBytes = 0;
  let maxBytes = 0;

  const snapshot = (): ByteCounterSnapshot => ({
    count,
    totalBytes,
    meanBytes: count === 0 ? 0 : totalBytes / count,
    maxBytes,
  });

  return {
    record(frame): ByteCounterSnapshot {
      const bytes = frame.jpeg.size;
      count += 1;
      totalBytes += bytes;
      maxBytes = Math.max(maxBytes, bytes);
      return snapshot();
    },
    snapshot,
    reset(): void {
      count = 0;
      totalBytes = 0;
      maxBytes = 0;
    },
  };
}
