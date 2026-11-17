/**
 * Downscale math for the image-embedding frames (card C4: "384 px JPEG frame").
 *
 * Port of the merged Kotlin reference
 * `apps/kotlin/app/src/main/java/dev/hajnina/scanlist/kotlin/scan/sources/FrameGeometry.kt`
 * (card B4): short side 384 px, aspect preserved, never upscale, both sides even. The web canvas
 * does not need even sides, but keeping the same pixels as Track B keeps the three tracks'
 * image queries comparable — a 4032×3024 phone frame becomes 384×288 here and in Kotlin.
 */

import type { FrameSize } from './types';

/** Short side of the frames handed to the image embedder (B4/C4 shared constant). */
export const EMBED_SHORT_SIDE = 384;

/** `canvas.toBlob('image/jpeg', quality)` — Kotlin encodes at 80; 384 px JPEG ≈ 20–40 kB. */
export const JPEG_QUALITY = 0.8;

/** Largest even value <= `v` (at least 2): rounding down cannot overflow the source. */
export function evenDown(value: number): number {
  const floored = Math.floor(value);
  return Math.max(2, floored - (floored % 2));
}

/** Smallest even value >= `v` (at least 2). */
export function evenUp(value: number): number {
  const ceil = Math.ceil(value);
  return Math.max(2, ceil % 2 === 0 ? ceil : ceil + 1);
}

/**
 * Target size for a `width`×`height` camera frame: short side = `shortSide` (384 by default), long
 * side scaled to keep the aspect ratio, both rounded UP to even numbers.
 *
 * Never upscales: a frame whose short side is already <= `shortSide` is returned (even-rounded),
 * because inventing pixels only costs encode time. The even rounding can shave one pixel.
 */
export function targetSize(
  width: number,
  height: number,
  shortSide: number = EMBED_SHORT_SIDE,
): FrameSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`frame must be positive, was ${width}x${height}`);
  }
  if (!Number.isFinite(shortSide) || shortSide <= 1) {
    throw new Error(`shortSide must be > 1, was ${shortSide}`);
  }

  const sourceShort = Math.min(width, height);
  if (sourceShort <= shortSide) {
    return { width: evenDown(width), height: evenDown(height) };
  }

  const targetShort = evenDown(shortSide);
  const scale = targetShort / sourceShort;
  const targetLong = evenUp(Math.max(width, height) * scale);

  return width <= height
    ? { width: targetShort, height: Math.max(targetLong, targetShort) }
    : { width: Math.max(targetLong, targetShort), height: targetShort };
}
