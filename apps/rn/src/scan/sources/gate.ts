/**
 * Rate gate (card A4).
 *
 * VisionCamera v5 removed the old `frameProcessInterval` throttle (deprecated, no-op in v2 of the
 * ML Kit plugin), and there is no first-party "process every N ms" switch left. The "magic scan"
 * budget of ~2.5 fps is therefore enforced here in JS: one gate in the capture loop (the camera is
 * only asked for a photo every 400 ms) and an optional gate per scan source (OCR is more expensive
 * than barcode decoding, so it runs at a lower rate off the same frames).
 */
import {type Clock, systemClock} from './clock';

export interface RateGate {
  readonly minIntervalMs: number;
  /**
   * Returns `true` at most once per `minIntervalMs`. Accepting records the timestamp.
   * The very first call always accepts.
   */
  tryAccept(at?: number): boolean;
  /** Timestamp of the last accepted call, or `undefined` before the first one. */
  lastAcceptedAt(): number | undefined;
  /** Forget the last acceptance (e.g. when the camera restarts). */
  reset(): void;
}

export function createRateGate(
  minIntervalMs: number,
  clock: Clock = systemClock,
): RateGate {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error(
      `rate gate interval must be a finite number >= 0, got ${minIntervalMs}`,
    );
  }
  let last: number | undefined;
  return {
    minIntervalMs,
    tryAccept(at: number = clock.now()): boolean {
      if (last !== undefined && at - last < minIntervalMs) {
        return false;
      }
      last = at;
      return true;
    },
    lastAcceptedAt(): number | undefined {
      return last;
    },
    reset(): void {
      last = undefined;
    },
  };
}
