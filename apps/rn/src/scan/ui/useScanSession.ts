/**
 * The scan screen's session wiring (card A5): A4 sources → the rank engine, paced at RANK.md §7's
 * 400 ms minimum interval.
 *
 * Thin by design (A4 precedent): it owns timers and lifecycle, nothing that decides a hero. The
 * testable behaviour is in `tick.ts` / `pool.ts`; this hook is covered indirectly by type-checking
 * and the bundle, exactly like `camera.tsx`.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {MIN_INTERVAL_MS} from '@scanlist/ts-core';
import {
  createScanPipeline,
  createScanSources,
  type FrameFeedSink,
  type ScanSignal,
} from '../sources';
import {createMlKitReaders} from '../sources/native';
import type {ScanTick, ScanTickEngine} from './tick';

export type ScanActivity = Readonly<
  Record<'barcode' | 'ocr' | 'image', number>
>;

/**
 * Card A6 dev counters (A4 review nit: `feed.listenerCount()` was documented as adb-observable and
 * is not). Read on demand by the scan screen's `__DEV__` footer, so a debug build can show what the
 * feed/sources are doing without a debugger: three listeners is healthy, a non-zero `dropped` means
 * ML Kit is slower than the 2.5 fps capture, and `pendingReleases` is the temp-JPEG backlog.
 */
export interface ScanDiagnostics {
  /** Sources attached to the frame feed (3 when running). */
  listeners: number;
  /** Frames skipped because a source's previous ML Kit call was still in flight. */
  dropped: number;
  /** Frames skipped by a source's own sample interval (OCR is slower than the camera). */
  skipped: number;
  /** Captured frames whose temp JPEG has not been deleted yet. */
  pendingReleases: number;
}

export interface ScanSession {
  /** Last completed rank tick, `null` until the first one. */
  tick: ScanTick | null;
  /** When each source last fired (chips). */
  activity: ScanActivity;
  /** Camera / ML Kit / embed error text shown in a card; cleared on the next good tick. */
  error: string | null;
  /** Ask for a tick now (still respecting the 400 ms interval) — used after committing an item. */
  scheduleTick: () => void;
  dismissError: () => void;
  /** Live feed/source counters for the dev footer (no state, no re-render on read). */
  diagnostics: () => ScanDiagnostics;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useScanSession(
  engine: ScanTickEngine,
  feed: FrameFeedSink,
): ScanSession {
  const [tick, setTick] = useState<ScanTick | null>(null);
  const [activity, setActivity] = useState<ScanActivity>(() =>
    engine.sourceActivity(),
  );
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTickAt = useRef(0);
  const busy = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  const runRef = useRef<() => void>(() => undefined);
  const diagnosticsRef = useRef<() => ScanDiagnostics>(() => ({
    listeners: 0,
    dropped: 0,
    skipped: 0,
    pendingReleases: 0,
  }));

  const run = useCallback(async () => {
    if (busy.current) {
      queued.current = true;
      return;
    }
    busy.current = true;
    lastTickAt.current = Date.now();
    try {
      const result = await engine.tick();
      if (!mounted.current) {
        return;
      }
      setTick(result);
      setActivity(engine.sourceActivity());
      if (result.error !== null) {
        setError(result.error);
      }
    } catch (failure) {
      if (mounted.current) {
        setError(messageOf(failure));
      }
    } finally {
      busy.current = false;
      if (queued.current && mounted.current) {
        queued.current = false;
        runRef.current();
      }
    }
  }, [engine]);

  runRef.current = () => {
    run().catch(() => undefined);
  };

  /** RANK.md §7: at most one evaluation per 400 ms; signals in between coalesce. */
  const scheduleTick = useCallback(() => {
    if (timer.current !== null) {
      return;
    }
    const wait = Math.max(
      0,
      MIN_INTERVAL_MS - (Date.now() - lastTickAt.current),
    );
    timer.current = setTimeout(() => {
      timer.current = null;
      runRef.current();
    }, wait);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const readers = createMlKitReaders();
    const {sources, barcode, ocr, image} = createScanSources(feed, {
      readers,
      onImage: frame => {
        // The image query is the frame's embedding (no prefix), not the JPEG itself.
        engine
          .pushImageFrame(frame)
          .then(scheduleTick)
          .catch(failure => {
            if (mounted.current) {
              setError(messageOf(failure));
            }
          });
      },
      onError: failure => {
        if (mounted.current) {
          setError(messageOf(failure));
        }
      },
    });
    const pipeline = createScanPipeline(sources);

    diagnosticsRef.current = () => ({
      listeners: feed.listenerCount(),
      dropped:
        barcode.droppedWhileBusy() +
        ocr.droppedWhileBusy() +
        image.droppedWhileBusy(),
      skipped:
        barcode.skippedByGate() + ocr.skippedByGate() + image.skippedByGate(),
      pendingReleases: feed.pendingReleases(),
    });

    pipeline
      .start((signal: ScanSignal) => {
        engine.pushSignal(signal);
        scheduleTick();
      })
      .catch(failure => {
        if (mounted.current) {
          setError(messageOf(failure));
        }
      });

    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // Scan stopped: clear rank state and queries (RANK.md §7).
      engine.reset();
      pipeline.stop().catch(() => undefined);
    };
  }, [engine, feed, scheduleTick]);

  return {
    tick,
    activity,
    error,
    scheduleTick,
    dismissError: () => setError(null),
    diagnostics: () => diagnosticsRef.current(),
  };
}
