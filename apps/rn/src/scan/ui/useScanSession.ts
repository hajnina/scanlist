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
    const {sources} = createScanSources(feed, {
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
  };
}
