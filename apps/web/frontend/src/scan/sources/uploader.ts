/**
 * Single-flight, newest-frame-wins image upload (card C4, cadence amendment 2026-11-17).
 *
 * The card's original text said "send to /embed/image every 400 ms". C3 measured the real server
 * path (`apps/web/server/PERF.md`): **6.4–11.9 s per image** on fp32 CPU, and `/embed/image` is not
 * queued server-side, so a 2.5 fps uploader would pile up ~20 requests during one embedding and
 * every result would be stale by the time it landed.
 *
 * So the browser keeps exactly **one POST in the air**. Frames keep arriving at the sampler's
 * ≤ 2.5 fps; the uploader:
 *
 *  - sends a frame immediately when nothing is in flight;
 *  - while a request is in flight, **replaces** the pending frame with each newer one (older pending
 *    frames are dropped, never queued);
 *  - when the request settles, sends the latest pending frame, if any.
 *
 * Every result carries the `capturedAt` of the frame it came from (`FrameEmbedResult.frame`), so the
 * ranker can apply RANK.md §2.2's "4 most recent image vectors from the last 2000 ms" window and
 * discard stale evidence instead of highlighting last shelf's product.
 *
 * C7's in-browser embedder plugs in as `embed`: the queueing policy stays identical, only the
 * latency changes.
 */

import { IMAGE_QUERY_MARKER } from './types';
import type { CapturedFrame, FrameEmbedResult, ImageEmbedding } from './types';

export interface FrameUploaderOptions {
  /** HTTP embedder (`createServerImageEmbedder`) or C7's local one — same interface. */
  embed: (frame: CapturedFrame) => Promise<ImageEmbedding>;
  onResult?: (result: FrameEmbedResult) => void;
  onError?: (error: unknown, frame: CapturedFrame) => void;
  /** Called for every frame replaced before it was ever sent (metrics/debug chip). */
  onCoalesced?: (replaced: CapturedFrame) => void;
}

export interface FrameUploaderStats {
  submitted: number;
  /** Frames actually handed to the embedder (one at a time). */
  sent: number;
  /** Pending frames replaced by a newer one before they were sent. */
  coalesced: number;
  failed: number;
  inFlight: boolean;
  pending: boolean;
}

export interface FrameUploader {
  /** Offer a frame; never blocks, never throws. */
  submit(frame: CapturedFrame): void;
  /** Resolves when nothing is in flight and nothing is pending. */
  idle(): Promise<void>;
  /** Stop sending; discards the pending frame (the in-flight request still settles). */
  close(): void;
  stats(): FrameUploaderStats;
}

export function createFrameUploader({
  embed,
  onResult,
  onError,
  onCoalesced,
}: FrameUploaderOptions): FrameUploader {
  let inFlight: Promise<void> | undefined;
  let pending: CapturedFrame | undefined;
  let closed = false;
  const counters = { submitted: 0, sent: 0, coalesced: 0, failed: 0 };

  function pump(): void {
    if (closed || inFlight !== undefined) return;
    const frame = pending;
    if (frame === undefined) return;
    pending = undefined;
    counters.sent += 1;

    inFlight = (async () => {
      try {
        const embedding = await embed(frame);
        if (!closed) onResult?.({ frame, embedding });
      } catch (error) {
        counters.failed += 1;
        onError?.(error, frame);
      } finally {
        inFlight = undefined;
        // Newest frame that arrived while this one was in the air.
        pump();
      }
    })();
  }

  return {
    submit(frame: CapturedFrame): void {
      if (closed) return;
      counters.submitted += 1;
      if (pending !== undefined) {
        counters.coalesced += 1;
        onCoalesced?.(pending);
      }
      pending = frame;
      pump();
    },
    async idle(): Promise<void> {
      // `await inFlight` may synchronously start the next upload in `finally`; loop until drained.
      while (inFlight !== undefined) {
        await inFlight;
      }
    },
    close(): void {
      closed = true;
      pending = undefined;
    },
    stats(): FrameUploaderStats {
      return {
        ...counters,
        inFlight: inFlight !== undefined,
        pending: pending !== undefined,
      };
    },
  };
}

/** Convenience: the A1-shaped image signal for a frame (the vector travels separately). */
export function imageSignal(at: number) {
  return { source: 'image' as const, text: IMAGE_QUERY_MARKER, confidence: 1, at };
}
