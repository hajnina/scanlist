/**
 * Card C4: JPEG frame size accounting and the local upload guards.
 *
 * A 384 px frame is ~20–40 kB; these helpers keep the debug numbers honest ("38 kB × 2.5 fps") and
 * fail locally — with a useful message — on the canvas failure modes the server would only reject
 * with a 400/413 after a round trip.
 */

import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_UPLOAD_BYTES } from '../embedder';
import { createByteCounter, frameUploadProblem, jpegStats } from '../jpeg';
import type { CapturedFrame } from '../types';

function frame(bytes: number, overrides: Partial<CapturedFrame> = {}): CapturedFrame {
  return {
    jpeg: new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
    width: 384,
    height: 288,
    capturedAt: 0,
    ...overrides,
  };
}

describe('jpegStats', () => {
  it('accounts bytes, pixels and bits per pixel', () => {
    const stats = jpegStats(frame(27_648)); // 384 × 288 at 2 bits/pixel
    expect(stats.bytes).toBe(27_648);
    expect(stats.pixels).toBe(384 * 288);
    expect(stats.bitsPerPixel).toBeCloseTo(2, 6);
  });

  it('handles a zero-sized frame without NaN', () => {
    expect(jpegStats(frame(0, { width: 0, height: 0 }))).toEqual({
      bytes: 0,
      pixels: 0,
      bitsPerPixel: 0,
    });
  });
});

describe('frameUploadProblem', () => {
  it('accepts a normal 384 px JPEG', () => {
    expect(frameUploadProblem(frame(30_000))).toBeUndefined();
  });

  it('rejects a canvas with no pixels (tab switch / camera not ready)', () => {
    expect(frameUploadProblem(frame(100, { width: 0, height: 288 }))).toMatch(/no pixels/);
  });

  it('rejects an empty JPEG', () => {
    expect(frameUploadProblem(frame(0))).toMatch(/empty/);
  });

  it('rejects a body above the server cap', () => {
    const oversized: CapturedFrame = {
      ...frame(1),
      jpeg: { size: MAX_IMAGE_UPLOAD_BYTES + 1, type: 'image/jpeg' } as Blob,
    };
    expect(frameUploadProblem(oversized)).toMatch(/server cap/);
  });

  it('rejects a non-JPEG blob (canvas fell back to PNG)', () => {
    const png: CapturedFrame = {
      ...frame(1000),
      jpeg: new Blob([new Uint8Array(10)], { type: 'image/png' }),
    };
    expect(frameUploadProblem(png)).toMatch(/not image\/jpeg/);
  });
});

describe('createByteCounter', () => {
  it('tracks count, total, mean and max, and resets', () => {
    const counter = createByteCounter();
    expect(counter.snapshot()).toEqual({ count: 0, totalBytes: 0, meanBytes: 0, maxBytes: 0 });

    counter.record(frame(20_000));
    const snapshot = counter.record(frame(40_000));
    expect(snapshot).toEqual({ count: 2, totalBytes: 60_000, meanBytes: 30_000, maxBytes: 40_000 });

    counter.reset();
    expect(counter.snapshot().count).toBe(0);
  });
});
