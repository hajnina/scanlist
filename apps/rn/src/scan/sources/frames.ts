/**
 * Frame fan-out (card A4) with the temp-JPEG lifecycle from card A6's A4-review nit.
 *
 * One camera capture per tick is shared by the barcode, OCR and image sources: the capture loop
 * pushes the frame into this feed, each source subscribes in `start()` and unsubscribes in `stop()`.
 * A listener that throws must not kill the camera, so errors are reported through
 * `onListenerError` and the remaining listeners still see the frame.
 *
 * **Temp files.** VisionCamera v5 can only hand barcode/OCR a JPEG *path*, so every sampled frame
 * leaves a file in the app cache (~100–200 KB at 2.5 fps ≈ 30 MB/min). A frame may carry a
 * `release()` (the capturer's delete call); the feed owns when that runs:
 *
 *  - after {@linkcode DEFAULT_FRAME_RELEASE_GRACE_MS}, which is long enough for the async readers
 *    (ML Kit, the embedder) to have opened the file, and short enough that a long scan does not
 *    accumulate gigabytes;
 *  - immediately on `releaseAll()` — the camera called it on unload, so nothing is left behind.
 *
 * The grace is a timer rather than reference counting because a source's `process()` is a black box
 * (it returns a value, not a completion signal); the timers are injectable, so the behaviour is unit
 * tested with fake timers.
 */
import type {CameraFrame, FrameFeed} from './types';

/** How long a delivered frame's temp JPEG stays readable for async consumers. */
export const DEFAULT_FRAME_RELEASE_GRACE_MS = 10_000;

export interface FrameFeedSink extends FrameFeed {
  push(frame: CameraFrame): void;
  listenerCount(): number;
  /** Delete every captured frame's temp file now (camera stopped / screen unmounted). */
  releaseAll(): void;
  /** Frames whose file is still waiting for its grace period — the scan screen's dev counter. */
  pendingReleases(): number;
}

export interface FrameFeedOptions {
  onListenerError?: (error: unknown) => void;
  /** Grace before a frame's temp file is deleted. Default {@linkcode DEFAULT_FRAME_RELEASE_GRACE_MS}. */
  releaseGraceMs?: number;
  /** Injectable timers (Jest fake timers are enough; this keeps the feed pure where wanted). */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createFrameFeed(
  options: FrameFeedOptions = {},
): FrameFeedSink {
  const {
    onListenerError,
    releaseGraceMs = DEFAULT_FRAME_RELEASE_GRACE_MS,
    setTimer = (handler, ms) => setTimeout(handler, ms),
    clearTimer = handle =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  const listeners = new Set<(frame: CameraFrame) => void>();
  /** frame → timer handle, for every delivered frame whose file is still on disk. */
  const pending = new Map<CameraFrame, unknown>();

  const releaseNow = (frame: CameraFrame): void => {
    if (!pending.has(frame)) {
      return;
    }
    const timer = pending.get(frame);
    pending.delete(frame);
    clearTimer(timer);
    try {
      const outcome = frame.release?.();
      if (outcome !== undefined) {
        // A failed delete must not surface as an unhandled rejection; the file is cache garbage.
        Promise.resolve(outcome).catch(() => undefined);
      }
    } catch {
      // Same: a release hook that throws cannot break the feed.
    }
  };

  const scheduleRelease = (frame: CameraFrame): void => {
    if (frame.release === undefined || pending.has(frame)) {
      return;
    }
    pending.set(
      frame,
      setTimer(() => releaseNow(frame), releaseGraceMs),
    );
  };

  return {
    subscribe(listener: (frame: CameraFrame) => void): () => void {
      // Wrap so the same function can be subscribed twice (e.g. two hashes of one handler).
      const entry = (frame: CameraFrame) => listener(frame);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    push(frame: CameraFrame): void {
      // Copy: a listener may unsubscribe (or subscribe) while the frame is being delivered.
      for (const listener of [...listeners]) {
        try {
          listener(frame);
        } catch (error) {
          onListenerError?.(error);
        }
      }
      scheduleRelease(frame);
    },
    listenerCount(): number {
      return listeners.size;
    },
    releaseAll(): void {
      for (const frame of [...pending.keys()]) {
        releaseNow(frame);
      }
    },
    pendingReleases(): number {
      return pending.size;
    },
  };
}
