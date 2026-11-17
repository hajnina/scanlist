/**
 * Image scan source (card A4).
 *
 * The frame itself is the query: EmbeddingGemma 2 embeds images into the same 768-d space as the
 * item texts, so the ranker can compare "what the camera sees" to "milk, oat 1 l, dairy".
 *
 * The A1 `ScanSignal` carries a string, so the signal is a marker (`text: IMAGE_QUERY_MARKER`) and
 * the actual JPEG is handed to `onImage` — the app wires that to the embedder (`embedImage` /
 * server upload). The bytes come from `Photo.getFileDataAsync()` (base64 in `CameraFrame`), which
 * is the lead-note-sanctioned JPEG route; no Skia encoder is needed.
 */
import {type Clock, systemClock} from './clock';
import {createFeedSource, type FeedSource} from './feedSource';
import type {CameraFrame, FrameFeed} from './types';

/** `ScanSignal.text` for an image query that carries no text of its own. */
export const IMAGE_QUERY_MARKER = 'image:frame';

export interface ImageSourceOptions {
  /** Receives every sampled frame — wire this to the embedder / backend. */
  onImage?: (frame: CameraFrame) => void | Promise<void>;
  /** Minimum time between image queries. Default 400 ms (the camera rate). */
  minIntervalMs?: number;
  clock?: Clock;
  onError?: (error: unknown) => void;
}

export function createImageSource(
  feed: FrameFeed,
  {
    onImage,
    minIntervalMs = 0,
    clock = systemClock,
    onError,
  }: ImageSourceOptions,
): FeedSource {
  return createFeedSource({
    name: 'image',
    feed,
    minIntervalMs,
    clock,
    onError,
    async process(frame: CameraFrame) {
      if (onImage !== undefined) {
        await onImage(frame);
      }
      return {
        source: 'image' as const,
        text: IMAGE_QUERY_MARKER,
        confidence: 1,
      };
    },
  });
}
