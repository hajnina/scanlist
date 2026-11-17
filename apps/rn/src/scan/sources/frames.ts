/**
 * Frame fan-out (card A4).
 *
 * One camera capture per tick is shared by the barcode, OCR and image sources: the capture loop
 * pushes the frame into this feed, each source subscribes in `start()` and unsubscribes in
 * `stop()`. A listener that throws must not kill the camera, so errors are reported through
 * `onListenerError` and the remaining listeners still see the frame.
 */
import type {CameraFrame, FrameFeed} from './types';

export interface FrameFeedSink extends FrameFeed {
  push(frame: CameraFrame): void;
  listenerCount(): number;
}

export interface FrameFeedOptions {
  onListenerError?: (error: unknown) => void;
}

export function createFrameFeed(
  options: FrameFeedOptions = {},
): FrameFeedSink {
  const listeners = new Set<(frame: CameraFrame) => void>();

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
          options.onListenerError?.(error);
        }
      }
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}
