/**
 * Scan-screen guidance state (card A6 fix rounds): the things the pure copy in `polish.ts` cannot
 * decide by itself.
 *
 *  - **Model status** is a probe, not a render-time fact: `useModelStatus` asks the bridge once
 *    (`embedStatus()`) and maps the answer through the same `modelStatus.ts` decisions the settings
 *    model card uses, so the scan note and the settings card agree about "missing".
 *  - **Quiet time** needs a clock *and* a definition of useful work. A live camera emits one image
 *    marker per sampled frame (~2.5 fps), so the screen does re-render while the scene is dim; those
 *    markers only prove frames are flowing. `useScanGuidance` remembers the first frame, counts
 *    only barcode/OCR/hero results as useful, and re-renders on a cleaned-up 1 s interval so the
 *    6 s threshold is crossed on time even when no signal arrives.
 */
import {useEffect, useRef, useState} from 'react';
import {embedStatus} from '../../modules/embed';
import {
  factsFromNativeStatus,
  modelStatusFromFacts,
  type ModelStatus,
} from './modelStatus';
import {
  quietFor,
  scanGuidance,
  type ScanGuidance,
  type SourceActivity,
} from './polish';

export interface ModelProbeState {
  /** `null` until the probe resolves (or when the bridge is unavailable). */
  status: ModelStatus | null;
  /** True only for a genuinely missing bundle — an unreadable/old binary is not "missing". */
  missing: boolean;
  /** The bridge's pinned sha label, when this binary reports one. */
  sha256: string | null;
}

export interface ModelProbeOptions {
  /** Injectable for tests; defaults to the bridge's `embedStatus()`. */
  probe?: () => Promise<{
    modelPresent?: unknown;
    modelPath?: unknown;
    modelBytes?: unknown;
    modelReadable?: unknown;
    modelSha256?: unknown;
  }>;
}

/**
 * Probe the model bundle once per mount. A failed/old bridge resolves to `missing: false` on
 * purpose: a probe error must not tell the user their model is gone.
 */
export function useModelStatus({
  probe = embedStatus,
}: ModelProbeOptions = {}): ModelProbeState {
  const [state, setState] = useState<ModelProbeState>({
    status: null,
    missing: false,
    sha256: null,
  });

  useEffect(() => {
    let active = true;
    probe()
      .then(status => {
        if (!active) {
          return;
        }
        const facts = factsFromNativeStatus({
          modelPresent: status.modelPresent === true,
          modelPath:
            typeof status.modelPath === 'string' ? status.modelPath : '',
          modelBytes:
            typeof status.modelBytes === 'number' ? status.modelBytes : undefined,
          modelReadable:
            typeof status.modelReadable === 'boolean'
              ? status.modelReadable
              : undefined,
        });
        const model = modelStatusFromFacts(facts);
        setState({
          status: model,
          missing: model.kind === 'missing',
          sha256:
            typeof status.modelSha256 === 'string' ? status.modelSha256 : null,
        });
      })
      .catch(() => {
        // Keep the previous state: an unavailable bridge is not a missing bundle.
      });
    return () => {
      active = false;
    };
    // `probe` is stable in the app (the module function); tests pass a new one per render on purpose.
  }, [probe]);

  return state;
}

export interface ScanGuidanceInput {
  hasPermission: boolean;
  canRequestPermission?: boolean;
  /** When each source last fired (ms since epoch, 0 = never). */
  activity: SourceActivity;
  /**
   * Latest completed rank tick. Only `heroId`/`at` are read: a tick that produced a hero
   * (`topId !== null`) is a useful result and resets the quiet clock. Optional so the pure
   * guidance can be tested without a scan engine.
   */
  tick?: {heroId: string | null; at: number} | null;
  modelMissing?: boolean;
  /** Ticker period; 1000 ms is enough to cross `QUIET_GUIDANCE_MS` on time. */
  intervalMs?: number;
  /** Injectable clock (tests advance Jest's fake `Date.now` instead). */
  now?: () => number;
}

/** The single guidance note for the scan screen, recomputed at least once per second. */
export function useScanGuidance({
  hasPermission,
  canRequestPermission = false,
  activity,
  tick = null,
  modelMissing = false,
  intervalMs = 1_000,
  now = Date.now,
}: ScanGuidanceInput): ScanGuidance | null {
  // The value is not read in render except to force the recompute; `now()` below is authoritative.
  const [, setTick] = useState(0);
  /** First frame since this screen mounted; starts the quiet clock (0 = camera not delivering). */
  const firstFrameAt = useRef(0);
  /** Newest hero tick; persists across later ticks so one good find resets the whole stretch. */
  const heroAt = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  useEffect(() => {
    if (firstFrameAt.current === 0 && activity.image > 0) {
      firstFrameAt.current = activity.image;
    }
  }, [activity.image]);

  useEffect(() => {
    if (tick !== null && tick.heroId !== null) {
      heroAt.current = tick.at;
    }
  }, [tick]);

  return scanGuidance({
    hasPermission,
    canRequestPermission,
    modelMissing,
    quietMs: quietFor(
      {
        ...activity,
        firstFrameAt: firstFrameAt.current,
        heroAt: heroAt.current,
      },
      now(),
    ),
  });
}
