/**
 * OCR scan source (card A4).
 *
 * Text recognition is the expensive source (~tens of ms per frame on a phone), so it samples the
 * shared ~2.5 fps frames at a lower rate (`minIntervalMs`, default 800 ms) and only emits when the
 * frame carries enough text to rank on. The reader is injected — in the app it is
 * `processImageTextRecognition(frame.filePath, {language: 'LATIN'})` from
 * `react-native-vision-camera-mlkit`.
 */
import {type Clock, systemClock} from './clock';
import {createFeedSource, type FeedSource} from './feedSource';
import {type OcrResultLike, ocrSignal} from './ocr';
import type {CameraFrame, FrameFeed} from './types';

export const DEFAULT_OCR_INTERVAL_MS = 800;

export interface OcrSourceOptions {
  /** Recognize text in a frame; resolves with ML Kit's blocks/lines. */
  read: (frame: CameraFrame) => Promise<OcrResultLike>;
  /** Minimum time between recognized frames. Default 800 ms. */
  minIntervalMs?: number;
  /** Ignore results shorter than this after whitespace normalisation. Default 3. */
  minChars?: number;
  clock?: Clock;
  onError?: (error: unknown) => void;
}

export function createOcrSource(
  feed: FrameFeed,
  {
    read,
    minIntervalMs = DEFAULT_OCR_INTERVAL_MS,
    minChars = 3,
    clock = systemClock,
    onError,
  }: OcrSourceOptions,
): FeedSource {
  return createFeedSource({
    name: 'ocr',
    feed,
    minIntervalMs,
    clock,
    onError,
    async process(frame: CameraFrame) {
      const result = await read(frame);
      return ocrSignal(result, minChars);
    },
  });
}
