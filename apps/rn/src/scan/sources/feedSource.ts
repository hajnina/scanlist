/**
 * Shared plumbing for feed-backed scan sources (card A4).
 *
 * Each source (`barcode`, `ocr`, `image`) is the same shape:
 *  - subscribe to the frame feed on `start()`, unsubscribe on `stop()`;
 *  - skip frames that arrive within its own `minIntervalMs` (OCR is a lot more expensive than
 *    barcode decoding, so it samples the shared frames at a lower rate);
 *  - single-flight: while a frame is being processed, newer frames are dropped rather than queued —
 *    a scan overlay wants "the latest answer", not a backlog;
 *  - turn one frame into zero, one or many {@linkcode ScanSignal}s.
 *
 * `process` is injected (pure logic + a reader in the app), so the sources are unit-tested without
 * a camera or ML Kit.
 */
import {type Clock, systemClock} from './clock';
import {createRateGate} from './gate';
import type {
  CameraFrame,
  FrameFeed,
  ScanSignal,
  ScanSource,
  ScanSourceName,
} from './types';

export interface FeedSourceOptions {
  name: ScanSourceName;
  feed: FrameFeed;
  process: (
    frame: CameraFrame,
  ) =>
    | Promise<ScanSignal | ScanSignal[] | undefined>
    | ScanSignal
    | ScanSignal[]
    | undefined;
  /** Skip frames closer together than this. Default: use every captured frame (0). */
  minIntervalMs?: number;
  clock?: Clock;
  onError?: (error: unknown) => void;
}

export interface FeedSource extends ScanSource {
  /** Frames dropped because the previous one was still being processed. Diagnostics for the UI. */
  droppedWhileBusy(): number;
  /** Frames skipped by the per-source interval gate. */
  skippedByGate(): number;
}

export function createFeedSource({
  name,
  feed,
  process,
  minIntervalMs = 0,
  clock = systemClock,
  onError,
}: FeedSourceOptions): FeedSource {
  const gate = createRateGate(minIntervalMs, clock);
  let unsubscribe: (() => void) | undefined;
  let busy = false;
  let dropped = 0;
  let skipped = 0;
  // Set by start(); cleared on stop() so a capture that resolves after stop() is not delivered.
  let onSignal: ((signal: ScanSignal) => void) | undefined;

  const handleFrame = (frame: CameraFrame): void => {
    if (busy) {
      dropped += 1;
      return;
    }
    if (!gate.tryAccept()) {
      skipped += 1;
      return;
    }

    busy = true;
    (async () => {
      try {
        const produced = await process(frame);
        if (produced === undefined) {
          return;
        }
        for (const signal of Array.isArray(produced) ? produced : [produced]) {
          onSignal?.(signal);
        }
      } catch (error) {
        onError?.(error);
      } finally {
        busy = false;
      }
    })().catch(error => onError?.(error));
  };

  return {
    name,
    async start(listener: (signal: ScanSignal) => void): Promise<void> {
      onSignal = listener;
      if (unsubscribe !== undefined) {
        return; // already running — keep the single subscription
      }
      gate.reset();
      unsubscribe = feed.subscribe(handleFrame);
    },
    async stop(): Promise<void> {
      onSignal = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      busy = false;
      gate.reset();
    },
    droppedWhileBusy: () => dropped,
    skippedByGate: () => skipped,
  };
}
