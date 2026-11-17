/**
 * Barcode scan source (card C4).
 *
 * One frame in, zero or one {@linkcode ScanSignal} out: the detector's raw results go through
 * `selectBarcode` (product-over-QR priority) and the per-value debounce, so pointing at one product
 * produces one signal instead of one per 150 ms copy tick.
 *
 * The detector is injected (`detector.ts` selects native or zxing); this module is pure logic and
 * fully unit-testable with fake detectors and a synthetic clock.
 */

import { type BarcodeLike, barcodeSignal, selectBarcode } from './barcode';
import type { BarcodeDeduper } from './dedupe';
import { createBarcodeDeduper } from './dedupe';
import type { BarcodeDetectorLike, BarcodeSource } from './detector';
import type { ScanSignal } from './types';

export interface BarcodeScanOptions {
  detector: Pick<BarcodeDetectorLike, 'detect'>;
  deduper?: BarcodeDeduper;
  onError?: (error: unknown) => void;
}

export interface BarcodeScanner {
  /**
   * Detect and shape this frame's barcode. Returns `[]` when nothing decodes, when the code is a
   * repeat inside the hold window, or when the detector throws (reported via `onError`).
   */
  scan(source: BarcodeSource, now?: number): Promise<ScanSignal[]>;
  reset(): void;
}

export function createBarcodeScanner({
  detector,
  deduper = createBarcodeDeduper(),
  onError,
}: BarcodeScanOptions): BarcodeScanner {
  return {
    async scan(source: BarcodeSource, now?: number): Promise<ScanSignal[]> {
      let results: readonly BarcodeLike[];
      try {
        results = await detector.detect(source);
      } catch (error) {
        onError?.(error);
        return [];
      }
      const barcode = selectBarcode(results);
      if (barcode === undefined) return [];
      const signal = barcodeSignal(barcode, now);
      if (signal === undefined) return [];
      if (!deduper.accept(signal.text, now)) return [];
      return [signal];
    },
    reset(): void {
      deduper.reset();
    },
  };
}
