/**
 * OCR scan source (card A4, per-line per shared/spec/RANK.md §2.2).
 *
 * Text recognition is the expensive source (~tens of ms per frame on a phone), so it samples the
 * shared ~2.5 fps frames at a lower rate (`minIntervalMs`, default 800 ms). Each released frame
 * becomes a **batch of line signals** (one per OCR line, detection order, ≤ 16) — the A1
 * {@linkcode ScanSource} callback stays single-signal, so the batch is delivered as consecutive
 * ordered `onSignal` calls (no contract change). The reader is injected — in the app it is
 * `processImageTextRecognition(frame.filePath, {language: 'LATIN'})` from
 * `react-native-vision-camera-mlkit`.
 */
import {type Clock, systemClock} from './clock';
import {createFeedSource, type FeedSource} from './feedSource';
import {
  createOcrLineDeduper,
  type OcrResultLike,
  ocrLineSignals,
} from './ocr';
import type {CameraFrame, FrameFeed} from './types';

export const DEFAULT_OCR_INTERVAL_MS = 800;

export interface OcrSourceOptions {
  /** Recognize text in a frame; resolves with ML Kit's blocks/lines. */
  read: (frame: CameraFrame) => Promise<OcrResultLike>;
  /** Minimum time between recognized frames. Default 800 ms. */
  minIntervalMs?: number;
  /** Ignore lines shorter than this after whitespace normalisation. Default 3. */
  minChars?: number;
  /** Max OCR line signals per batch. Default 16 (RANK.md's text-vector pool cap). */
  maxLines?: number;
  /** Do not re-emit an identical line within this window. Default 4000 ms. */
  repeatMs?: number;
  clock?: Clock;
  onError?: (error: unknown) => void;
}

export function createOcrSource(
  feed: FrameFeed,
  {
    read,
    minIntervalMs = DEFAULT_OCR_INTERVAL_MS,
    minChars,
    maxLines,
    repeatMs,
    clock = systemClock,
    onError,
  }: OcrSourceOptions,
): FeedSource {
  // One deduper for the source's lifetime: the repeat window spans ticks, not batches.
  const deduper = createOcrLineDeduper(repeatMs, clock);

  return createFeedSource({
    name: 'ocr',
    feed,
    minIntervalMs,
    clock,
    onError,
    async process(frame: CameraFrame) {
      const result = await read(frame);
      return ocrLineSignals(result, {minChars, maxLines, deduper, clock});
    },
  });
}
