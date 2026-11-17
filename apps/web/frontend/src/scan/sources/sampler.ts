/**
 * Camera cadence gate (card C4).
 *
 * Two budgets, one gate, because the browser pays two very different costs per frame:
 *
 *  - **copy** every ~150 ms: `drawImage(video → canvas)` + `BarcodeDetector.detect()`. The lead's
 *    research digest asks for a ~150 ms frame copy with
 *    `getContext('2d', {willReadFrequently: true})`; detection is cheap enough for that rate.
 *  - **embed** at 2.5 fps (400 ms): the 384 px JPEG + image query. That is the ≤ 2.5 fps budget
 *    from B4 and the card. It is the *capture* budget only — the actual upload is coalesced by
 *    `uploader.ts` (single in-flight, newest frame wins), because C3 measured 6.4–11.9 s per
 *    server-side image embedding (apps/web/server/PERF.md). See the C4 cadence amendment.
 *
 * Embed ticks are always a subset of copy ticks: an embed without a fresh canvas copy would ship a
 * stale frame.
 */

import { type Clock, systemClock } from './clock';

export const FRAME_COPY_INTERVAL_MS = 150;
/** 2.5 fps = one frame every 400 ms (Kotlin `FrameSampler.DEFAULT_MIN_INTERVAL_MS`). */
export const EMBED_FRAME_INTERVAL_MS = 400;

export interface FrameCadenceDecision {
  /** Copy the video frame to the canvas and run barcode detection this tick. */
  copy: boolean;
  /** Also encode the 384 px JPEG and offer it to the image source this tick. */
  embed: boolean;
}

export interface FrameCadenceOptions {
  copyIntervalMs?: number;
  embedIntervalMs?: number;
  clock?: Clock;
}

export interface FrameCadence {
  readonly copyIntervalMs: number;
  readonly embedIntervalMs: number;
  /** Decide for the frame observed at `now`; records the tick when it says yes. */
  next(now?: number): FrameCadenceDecision;
  /** Forget the last tick (camera restarted / tab was hidden). */
  reset(): void;
}

export function createFrameCadence({
  copyIntervalMs = FRAME_COPY_INTERVAL_MS,
  embedIntervalMs = EMBED_FRAME_INTERVAL_MS,
  clock = systemClock,
}: FrameCadenceOptions = {}): FrameCadence {
  for (const [name, value] of [
    ['copyIntervalMs', copyIntervalMs],
    ['embedIntervalMs', embedIntervalMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite number >= 0, got ${value}`);
    }
  }

  let lastCopyAt: number | undefined;
  let lastEmbedAt: number | undefined;

  return {
    copyIntervalMs,
    embedIntervalMs,
    next(now: number = clock.now()): FrameCadenceDecision {
      // First frame after start/reset always passes both gates (a stationary camera still gets a
      // frame), exactly like Kotlin's FrameSampler.
      const copy = lastCopyAt === undefined || now - lastCopyAt >= copyIntervalMs;
      const embed = copy && (lastEmbedAt === undefined || now - lastEmbedAt >= embedIntervalMs);
      if (copy) lastCopyAt = now;
      if (embed) lastEmbedAt = now;
      return { copy, embed };
    },
    reset(): void {
      lastCopyAt = undefined;
      lastEmbedAt = undefined;
    },
  };
}
