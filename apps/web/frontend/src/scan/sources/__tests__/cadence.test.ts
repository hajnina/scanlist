/**
 * Card C4: the camera cadence gate and the 384 px frame math.
 *
 * The gate is the card's "~150 ms frame copy" + "2.5 fps embed budget"; the geometry mirrors the
 * merged Kotlin reference (`FrameGeometry.kt`) so Track B and Track C send the same pixels.
 */

import { describe, expect, it } from 'vitest';

import {
  EMBED_FRAME_INTERVAL_MS,
  FRAME_COPY_INTERVAL_MS,
  createFrameCadence,
} from '../sampler';
import {
  EMBED_SHORT_SIDE,
  JPEG_QUALITY,
  evenDown,
  evenUp,
  targetSize,
} from '../geometry';

describe('frame cadence (150 ms copy / 2.5 fps embed)', () => {
  it('uses the documented constants', () => {
    expect(FRAME_COPY_INTERVAL_MS).toBe(150);
    expect(EMBED_FRAME_INTERVAL_MS).toBe(400);
    expect(EMBED_SHORT_SIDE).toBe(384);
    expect(JPEG_QUALITY).toBeCloseTo(0.8);
  });

  it('copies every ~150 ms and embeds at most every 400 ms', () => {
    const cadence = createFrameCadence();
    expect(cadence.next(0)).toEqual({ copy: true, embed: true });
    expect(cadence.next(100)).toEqual({ copy: false, embed: false });
    expect(cadence.next(149)).toEqual({ copy: false, embed: false });
    expect(cadence.next(150)).toEqual({ copy: true, embed: false });
    expect(cadence.next(300)).toEqual({ copy: true, embed: false });
    // 450 is the first copy tick at least 400 ms after the embed at 0.
    expect(cadence.next(450)).toEqual({ copy: true, embed: true });
    expect(cadence.next(500)).toEqual({ copy: false, embed: false });
    expect(cadence.next(600)).toEqual({ copy: true, embed: false });
    expect(cadence.next(750)).toEqual({ copy: true, embed: false });
    expect(cadence.next(900)).toEqual({ copy: true, embed: true });
  });

  it('never embeds without a fresh copy (no stale frames)', () => {
    const cadence = createFrameCadence();
    cadence.next(0);
    cadence.next(150);
    cadence.next(300);
    // 400 ms have passed since the embed, but the last copy was at 300 ms: 100 ms < 150 ms, so
    // this frame is not even copied and must not be embedded.
    expect(cadence.next(400)).toEqual({ copy: false, embed: false });
    expect(cadence.next(450)).toEqual({ copy: true, embed: true });
  });

  it('reset() makes the next frame pass both gates (camera restart)', () => {
    const cadence = createFrameCadence();
    cadence.next(0);
    cadence.next(1000);
    cadence.reset();
    expect(cadence.next(1001)).toEqual({ copy: true, embed: true });
  });

  it('honours custom intervals and rejects nonsense', () => {
    const cadence = createFrameCadence({ copyIntervalMs: 50, embedIntervalMs: 100 });
    expect(cadence.next(0)).toEqual({ copy: true, embed: true });
    expect(cadence.next(50)).toEqual({ copy: true, embed: false });
    expect(cadence.next(100)).toEqual({ copy: true, embed: true });
    expect(() => createFrameCadence({ copyIntervalMs: -1 })).toThrow(/copyIntervalMs/);
    expect(() => createFrameCadence({ embedIntervalMs: Number.NaN })).toThrow(/embedIntervalMs/);
  });
});

describe('384 px frame geometry (port of B4 FrameGeometry.kt)', () => {
  it('scales a 4:3 phone frame to a 384 px short side', () => {
    expect(targetSize(4032, 3024)).toEqual({ width: 512, height: 384 });
  });

  it('keeps the aspect ratio in portrait', () => {
    expect(targetSize(3024, 4032)).toEqual({ width: 384, height: 512 });
  });

  it('scales a 16:9 webcam frame (desktop fallback)', () => {
    // 1280 × (384/720) = 682.67 → rounded UP to even 684.
    expect(targetSize(1280, 720)).toEqual({ width: 684, height: 384 });
  });

  it('never upscales a frame that is already small', () => {
    expect(targetSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(targetSize(384, 384)).toEqual({ width: 384, height: 384 });
  });

  it('rounds both sides to even numbers (same pixels as Kotlin)', () => {
    expect(targetSize(321, 241)).toEqual({ width: 320, height: 240 });
    expect(evenDown(319)).toBe(318);
    expect(evenDown(2)).toBe(2);
    expect(evenUp(319)).toBe(320);
    expect(evenUp(2)).toBe(2);
  });

  it('honours a custom short side', () => {
    expect(targetSize(1000, 500, 100)).toEqual({ width: 200, height: 100 });
  });

  it('rejects degenerate input instead of producing 0×0', () => {
    expect(() => targetSize(0, 100)).toThrow(/positive/);
    expect(() => targetSize(100, -1)).toThrow(/positive/);
    expect(() => targetSize(100, 100, 1)).toThrow(/shortSide/);
  });
});
