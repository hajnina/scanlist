/**
 * Camera capture loop (card A4).
 *
 * VisionCamera v5 has no frame-interval throttle, so this is the "~2.5 fps" self-gate the lead note
 * asked for: one photo every `intervalMs` (default 400 ms), never overlapping (a slow capture or a
 * busy device simply lowers the effective rate instead of queueing work), and restarted cleanly
 * with the camera session.
 *
 * The loop is deliberately camera-agnostic: `capture()` is injected (in the app it is
 * `createFrameCapturer(photoOutput)` from ./native), so the whole schedule is unit-tested with
 * fake timers.
 */
import {type Clock, systemClock} from './clock';
import type {CameraFrame} from './types';

export const DEFAULT_FRAME_INTERVAL_MS = 400;

export interface CaptureLoopOptions {
  capture: () => Promise<CameraFrame>;
  onFrame: (frame: CameraFrame) => void;
  onError?: (error: unknown) => void;
  /** Minimum time between the starts of two captures. Default 400 ms (~2.5 fps). */
  intervalMs?: number;
  clock?: Clock;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CaptureLoop {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export function createCaptureLoop({
  capture,
  onFrame,
  onError,
  intervalMs = DEFAULT_FRAME_INTERVAL_MS,
  clock = systemClock,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: CaptureLoopOptions): CaptureLoop {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(
      `capture interval must be a finite number >= 0, got ${intervalMs}`,
    );
  }

  let running = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeoutFn(() => {
      timer = undefined;
      tick().catch(error => onError?.(error));
    }, Math.max(0, delayMs));
  };

  async function tick(): Promise<void> {
    if (!running) {
      return;
    }
    if (inFlight) {
      // A second timer fired while a capture was still running — try again next interval.
      schedule(intervalMs);
      return;
    }

    inFlight = true;
    const startedAt = clock.now();
    let frame: CameraFrame | undefined;
    try {
      frame = await capture();
    } catch (error) {
      onError?.(error);
    } finally {
      inFlight = false;
    }

    if (!running) {
      return;
    }

    if (frame !== undefined) {
      try {
        onFrame(frame);
      } catch (error) {
        onError?.(error);
      }
    }

    const elapsed = clock.now() - startedAt;
    schedule(intervalMs - elapsed);
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      schedule(0);
    },
    stop(): void {
      running = false;
      if (timer !== undefined) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
    },
    isRunning(): boolean {
      return running;
    },
  };
}
