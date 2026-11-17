/**
 * Injectable clock for the scan sources (card A4).
 *
 * Every timing decision in this directory (the ~2.5 fps capture budget, the barcode debounce, the
 * per-source frame intervals) takes a {@linkcode Clock} so the logic can be unit-tested with fake
 * time instead of `Date.now()` sprinkled around.
 */
export interface Clock {
  /** Milliseconds since the epoch, monotonic enough for gating (Date.now() is fine here). */
  now(): number;
}

export const systemClock: Clock = {now: () => Date.now()};
