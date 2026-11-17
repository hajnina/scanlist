/**
 * OCR scan source (card C4): lazy Tesseract.js behind a non-overlapping tick.
 *
 * Tesseract is the slow source on the web (hundreds of ms to seconds per frame, plus a one-off
 * worker/traineddata load), so the source:
 *
 *  - runs on its own ~1 s tick, not the 150 ms copy tick — barcode detection stays fast;
 *  - **never stacks**: while `recognize()` is in flight, ticks are skipped (the next tick reads the
 *    freshest canvas anyway, so skipping loses nothing);
 *  - grabs the frame **at recognition time** (`grab()`), not when the tick was scheduled;
 *  - turns the page into one signal per line through `ocrLineSignals` (RANK.md §2.2, shared repeat
 *    window across ticks).
 *
 * Everything is injected (engine, grab, clock, timers), so the whole thing is tested in happy-dom
 * with a fake engine.
 */

import { systemClock } from './clock';
import {
  type OcrLineDeduper,
  type OcrLineSignalsOptions,
  createOcrLineDeduper,
  ocrLineSignals,
} from './ocr';
import type { OcrEngine } from './ocrEngine';
import type { ScanSignal } from './types';

/** One OCR pass per second: Tesseract on a phone is ~0.5–2 s/frame, so faster ticks only skip. */
export const DEFAULT_OCR_INTERVAL_MS = 1000;

export interface OcrSourceOptions extends OcrLineSignalsOptions {
  engine: OcrEngine;
  /** Grab the current frame (the 384 px canvas) when recognition starts. */
  grab: () => Promise<Blob | undefined>;
  intervalMs?: number;
  onSignals: (signals: ScanSignal[]) => void;
  onError?: (error: unknown) => void;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface OcrSource {
  start(): void;
  stop(): void;
  /** Run one recognition now (also used by the timer). Returns the signals emitted, possibly none. */
  tick(now?: number): Promise<ScanSignal[]>;
  isBusy(): boolean;
}

export function createOcrSource({
  engine,
  grab,
  intervalMs = DEFAULT_OCR_INTERVAL_MS,
  onSignals,
  onError,
  repeatMs,
  deduper,
  minChars,
  maxLines,
  clock = systemClock,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: OcrSourceOptions): OcrSource {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`ocr interval must be a finite number > 0, got ${intervalMs}`);
  }
  const dedupe: OcrLineDeduper = deduper ?? createOcrLineDeduper(repeatMs, clock);
  let busy = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    if (!running) return;
    timer = setTimeoutFn(() => {
      timer = undefined;
      void tick().finally(schedule);
    }, intervalMs);
  }

  async function tick(now: number = clock.now()): Promise<ScanSignal[]> {
    if (busy) return [];
    busy = true;
    try {
      const frame = await grab();
      if (frame === undefined) return [];
      const result = await engine.recognize(frame);
      // A fixed clock reading for the whole tick: every line in one OCR page shares its timestamp.
      const signals = ocrLineSignals(result, {
        minChars,
        maxLines,
        deduper: dedupe,
        clock: { now: () => now },
      });
      if (signals.length > 0) onSignals(signals);
      return signals;
    } catch (error) {
      onError?.(error);
      return [];
    } finally {
      busy = false;
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      schedule();
    },
    stop(): void {
      running = false;
      if (timer !== undefined) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
    },
    tick,
    isBusy: () => busy,
  };
}
