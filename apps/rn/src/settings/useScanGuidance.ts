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
import {
  embedStatus,
  type EmbedDownload,
  type EmbedDownloadState,
} from '../../modules/embed';
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
  /** Card MODELDL: in-app download progress, or null before the first probe. */
  download: EmbedDownload | null;
}

const DOWNLOAD_STATES: readonly EmbedDownloadState[] = [
  'idle',
  'downloading',
  'verifying',
  'ready',
  'failed',
];

/**
 * Maps the bridge's `download` payload defensively: an older binary has no field, and a partially
 * released one must not crash the screen. Unknown states read as `idle`.
 */
export function downloadFromNativeStatus(value: unknown): EmbedDownload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const shape = value as Record<string, unknown>;
  const state = DOWNLOAD_STATES.includes(shape.state as EmbedDownloadState)
    ? (shape.state as EmbedDownloadState)
    : 'idle';
  const number = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : 0;
  return {
    state,
    bytes: number(shape.bytes),
    total: number(shape.total),
    pct: Math.min(100, Math.floor(number(shape.pct))),
    error: typeof shape.error === 'string' ? shape.error : null,
  };
}

export interface ModelProbeOptions {
  /** Injectable for tests; defaults to the bridge's `embedStatus()`. */
  probe?: () => Promise<{
    modelPresent?: unknown;
    modelPath?: unknown;
    modelBytes?: unknown;
    modelReadable?: unknown;
    modelSha256?: unknown;
    download?: unknown;
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
    download: null,
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = () => {
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
              typeof status.modelBytes === 'number'
                ? status.modelBytes
                : undefined,
            modelReadable:
              typeof status.modelReadable === 'boolean'
                ? status.modelReadable
                : undefined,
          });
          const model = modelStatusFromFacts(facts);
          const download = downloadFromNativeStatus(status.download);
          setState({
            status: model,
            missing: model.kind === 'missing',
            sha256:
              typeof status.modelSha256 === 'string'
                ? status.modelSha256
                : null,
            download,
          });
          // Card MODELDL: cheap re-check while bytes are moving; no polling once ready/failed.
          if (
            download?.state === 'downloading' ||
            download?.state === 'verifying'
          ) {
            timer = setTimeout(poll, 1_000);
          }
        })
        .catch(() => {
          // Keep the previous state: an unavailable bridge is not a missing bundle.
        });
    };
    poll();
    return () => {
      active = false;
      if (timer !== null) {
        clearTimeout(timer);
      }
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
  /** Card MODELDL: in-app download progress shown in the model note. */
  modelDownload?: {
    state: string;
    pct?: number;
    error?: string | null;
  } | null;
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
  modelDownload = null,
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
    modelDownload,
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
