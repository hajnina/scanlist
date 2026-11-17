/**
 * Barcode scan source (card A4).
 *
 * Reads the barcode(s) in a sampled frame with ML Kit and emits one signal per newly seen code.
 * The reader is injected — in the app it is
 * `processImageBarcodeScanning(frame.filePath, {formats: PRODUCT_FORMATS})` from
 * `react-native-vision-camera-mlkit` (see ./native) — so the debounce/gating behaviour is tested
 * without the native module.
 *
 * Device notes (VisionCamera v5 / ML Kit v2, both MIT):
 *  - the barcode scanner split out of the core package into `react-native-vision-camera-mlkit`
 *    (OCR + barcode) / `react-native-vision-camera-barcode-scanner` (barcode only); this card uses
 *    the ML Kit plugin so one capture serves barcode *and* OCR;
 *  - `frameProcessInterval` is deprecated and does NOT throttle in v5 — the ~2.5 fps budget lives
 *    in ./captureLoop and the per-source gate here.
 */
import {type BarcodeLike, barcodeSignal, selectBarcode} from './barcode';
import {type Clock, systemClock} from './clock';
import {createBarcodeDeduper, DEFAULT_BARCODE_HOLD_MS} from './dedupe';
import {createFeedSource, type FeedSource} from './feedSource';
import type {CameraFrame, FrameFeed} from './types';

/** The subset of `BarcodeScanningResult` a reader has to return. */
export interface BarcodeReadResult {
  barcodes: readonly BarcodeLike[];
}

export interface BarcodeSourceOptions {
  /** Decode a frame; resolves with ML Kit's barcode list (empty array if nothing was found). */
  read: (frame: CameraFrame) => Promise<BarcodeReadResult>;
  /** Do not re-emit the same value within this window. Default 4000 ms. */
  dedupeMs?: number;
  /** Minimum time between decoded frames. Default 400 ms (the camera rate). */
  minIntervalMs?: number;
  clock?: Clock;
  onError?: (error: unknown) => void;
}

export function createBarcodeSource(
  feed: FrameFeed,
  {
    read,
    dedupeMs = DEFAULT_BARCODE_HOLD_MS,
    minIntervalMs = 0,
    clock = systemClock,
    onError,
  }: BarcodeSourceOptions,
): FeedSource {
  const deduper = createBarcodeDeduper(dedupeMs, clock);

  return createFeedSource({
    name: 'barcode',
    feed,
    minIntervalMs,
    clock,
    onError,
    async process(frame: CameraFrame) {
      const result = await read(frame);
      const barcode = selectBarcode(result.barcodes);
      if (barcode === undefined) {
        return undefined;
      }
      const value = barcode.rawValue ?? barcode.displayValue ?? '';
      if (!deduper.accept(value, clock.now())) {
        return undefined;
      }
      return barcodeSignal(barcode);
    },
  });
}
