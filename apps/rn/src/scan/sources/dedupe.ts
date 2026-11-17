/**
 * Barcode debounce (card A4).
 *
 * ML Kit reports the same EAN on every decoded frame while the phone is pointed at one product.
 * The scan UI should light the barcode chip once, not 2.5 times per second, so a sighting only
 * produces a {@linkcode ScanSignal} if that exact value was not emitted within `holdMs`.
 *
 * Semantics:
 *  - a different value is emitted immediately (and becomes the current one);
 *  - the same value re-fires after `holdMs`, so a user who keeps the phone on one product and then
 *    comes back to it still gets a fresh signal instead of a dead chip;
 *  - the timer is per value, not per frame, so occasional frames that fail to decode do not reset
 *    the debounce.
 */
import {type Clock, systemClock} from './clock';

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
    throw new Error(
      `barcode hold must be a finite number >= 0, got ${holdMs}`,
    );
  }
  let currentValue: string | undefined;
  let lastEmittedAt: number | undefined;

  return {
    holdMs,
    accept(value: string, at: number = clock.now()): boolean {
      const normalized = value.trim();
      if (normalized.length === 0) {
        return false;
      }
      if (normalized !== currentValue) {
        currentValue = normalized;
        lastEmittedAt = at;
        return true;
      }
      if (lastEmittedAt !== undefined && at - lastEmittedAt < holdMs) {
        return false;
      }
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
