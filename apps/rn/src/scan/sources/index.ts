/**
 * Scan sources barrel (card A4 builds on the A1 contract in ./types).
 *
 *   const feed = createFrameFeed();
 *   const pipeline = createScanPipeline(createScanSources(feed, {readers, onImage}).sources);
 *   await pipeline.start(signal => …);      // barcode / ocr / image ScanSignals flow in
 *   feed.push(frame);                       // the camera view pushes ~2.5 fps captures
 *
 * Everything exported here is camera-free and unit-tested. The native side lives in
 * ./native (ML Kit readers + photo → frame) and ./camera (the `<ScanCamera>` view), which are
 * imported directly by the scan UI (card A5) so Jest never loads the native modules.
 */
import {type Clock, systemClock} from './clock';
import {createBarcodeSource} from './barcodeSource';
import {createImageSource} from './imageSource';
import {createOcrSource} from './ocrSource';
import type {ScanReaders} from './readers';
import type {
  CameraFrame,
  FrameFeed,
  ScanSignal,
  ScanSource,
} from './types';

export type {
  CameraFrame,
  FrameFeed,
  ScanSignal,
  ScanSource,
  ScanSourceName,
} from './types';
export type {Clock} from './clock';
export {systemClock} from './clock';
export {createRateGate, type RateGate} from './gate';
export {
  createBarcodeDeduper,
  DEFAULT_BARCODE_HOLD_MS,
  type BarcodeDeduper,
} from './dedupe';
export {arrayBufferToBase64, toDataUri} from './base64';
export {
  barcodeSignal,
  isProductBarcode,
  normalizeBarcodeValue,
  PRODUCT_BARCODE_FORMATS,
  PRODUCT_BARCODE_LENGTHS,
  selectBarcode,
  type BarcodeLike,
} from './barcode';
export {
  createOcrLineDeduper,
  DEFAULT_OCR_LINE_REPEAT_MS,
  extractOcrLines,
  lineConfidence,
  MAX_OCR_LINES_PER_TICK,
  NEUTRAL_OCR_CONFIDENCE,
  normalizeOcrText,
  ocrLineSignals,
  type OcrBlockLike,
  type OcrElementLike,
  type OcrLine,
  type OcrLineDeduper,
  type OcrLineLike,
  type OcrLineSignalsOptions,
  type OcrResultLike,
} from './ocr';
export {createFrameFeed, type FrameFeedSink} from './frames';
export {
  createCaptureLoop,
  DEFAULT_FRAME_INTERVAL_MS,
  type CaptureLoop,
  type CaptureLoopOptions,
} from './captureLoop';
export {createFeedSource, type FeedSource} from './feedSource';
export {
  createBarcodeSource,
  type BarcodeReadResult,
  type BarcodeSourceOptions,
} from './barcodeSource';
export {
  createOcrSource,
  DEFAULT_OCR_INTERVAL_MS,
  type OcrSourceOptions,
} from './ocrSource';
export {
  createImageSource,
  IMAGE_QUERY_MARKER,
  type ImageSourceOptions,
} from './imageSource';
export type {ScanReaders} from './readers';

export interface CreateScanSourcesOptions {
  readers: ScanReaders;
  /** JPEG frames for the image embedder / backend. */
  onImage?: (frame: CameraFrame) => void | Promise<void>;
  /** Same-barcode window. Default 4000 ms. */
  barcodeDedupeMs?: number;
  /** Barcode decode interval off the shared frames. Default: every frame. */
  barcodeIntervalMs?: number;
  /** OCR interval off the shared frames. Default 800 ms. */
  ocrIntervalMs?: number;
  /** Image query interval off the shared frames. Default: every frame. */
  imageIntervalMs?: number;
  /** Ignore OCR lines shorter than this. Default 3. */
  ocrMinChars?: number;
  /** Max OCR line signals per batch (RANK.md's text-vector pool cap). Default 16. */
  ocrMaxLines?: number;
  /** Same-OCR-line repeat window. Default 4000 ms. */
  ocrRepeatMs?: number;
  clock?: Clock;
  /** Any reader error (native reject, decode failure). Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

export interface ScanSources {
  barcode: ReturnType<typeof createBarcodeSource>;
  ocr: ReturnType<typeof createOcrSource>;
  image: ReturnType<typeof createImageSource>;
  /** `[barcode, ocr, image]`, in chip order for the UI. */
  sources: ScanSource[];
}

/**
 * Build the three A1-contract sources over one shared frame feed.
 *
 * Every source is independent: one failing ML Kit call reports through `onError` and the other
 * chips keep working.
 */
export function createScanSources(
  feed: FrameFeed,
  {
    readers,
    onImage,
    barcodeDedupeMs,
    barcodeIntervalMs,
    ocrIntervalMs,
    imageIntervalMs,
    ocrMinChars,
    ocrMaxLines,
    ocrRepeatMs,
    clock = systemClock,
    onError = (error: unknown) => {
      console.warn('[scan] source error', error);
    },
  }: CreateScanSourcesOptions,
): ScanSources {
  const barcode = createBarcodeSource(feed, {
    read: frame => readers.readBarcodes(frame),
    dedupeMs: barcodeDedupeMs,
    minIntervalMs: barcodeIntervalMs,
    clock,
    onError,
  });
  const ocr = createOcrSource(feed, {
    read: frame => readers.readText(frame),
    minIntervalMs: ocrIntervalMs,
    minChars: ocrMinChars,
    maxLines: ocrMaxLines,
    repeatMs: ocrRepeatMs,
    clock,
    onError,
  });
  const image = createImageSource(feed, {
    onImage,
    minIntervalMs: imageIntervalMs,
    clock,
    onError,
  });

  return {barcode, ocr, image, sources: [barcode, ocr, image]};
}

export interface ScanPipeline {
  start(onSignal: (signal: ScanSignal) => void): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

/** Start/stop a set of sources together (used by the scan screen on mount/unmount). */
export function createScanPipeline(
  sources: readonly ScanSource[],
): ScanPipeline {
  let running = false;
  return {
    async start(onSignal: (signal: ScanSignal) => void): Promise<void> {
      running = true;
      await Promise.all(sources.map(source => source.start(onSignal)));
    },
    async stop(): Promise<void> {
      running = false;
      await Promise.all(sources.map(source => source.stop()));
    },
    isRunning: () => running,
  };
}
