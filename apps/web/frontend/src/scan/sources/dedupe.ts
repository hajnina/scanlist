/**
 * Barcode debounce (card C4).
 *
 * Port of Track A's `apps/rn/src/scan/sources/dedupe.ts` (card A4): a detector sees the same EAN on
 * every frame while the phone is pointed at one product, and the scan UI should light the barcode
 * chip once, not ~6 times per second (the web copy cadence is 150 ms, hence the value matters more
 * here than on RN's 400 ms loop).
 *
 * Semantics:
 *  - a different value is emitted immediately (and becomes the current one);
 *  - the same value re-fires after `holdMs`, so coming back to a product still refreshes the chip;
 *  - the timer is per value, not per frame, so frames that fail to decode do not reset the hold.
 */

import { type Clock, systemClock } from './clock';

/** 4 s: same hold as A4/B4, long enough that one product produces one signal. */
export const DEFAULT_BARCODE_HOLD_MS = 4000;

export interface BarcodeDeduper {
  readonly holdMs: number;
  /** True if this value should be emitted now. */
  accept(value: string, at?: number): boolean;
  /** The last emitted value, if any. */
  current(): string | undefined;
  reset(): void;
}

export function createBarcodeDeduper(
  holdMs: number = DEFAULT_BARCODE_HOLD_MS,
  clock: Clock = systemClock,
): BarcodeDeduper {
  if (!Number.isFinite(holdMs) || holdMs < 0) {
    throw new Error(`barcode hold must be a finite number >= 0, got ${holdMs}`);
  }
  let currentValue: string | undefined;
  let lastEmittedAt: number | undefined;

  return {
    holdMs,
    accept(value: string, at: number = clock.now()): boolean {
      const normalized = value.trim();
      if (normalized.length === 0) return false;
      if (normalized !== currentValue) {
        currentValue = normalized;
        lastEmittedAt = at;
        return true;
      }
      if (lastEmittedAt !== undefined && at - lastEmittedAt < holdMs) return false;
      lastEmittedAt = at;
      return true;
    },
    current(): string | undefined {
      return currentValue;
    },
    reset(): void {
      currentValue = undefined;
      lastEmittedAt = undefined;
    },
  };
}
