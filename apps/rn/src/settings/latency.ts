/**
 * The settings self-test (card A6) — the RN twin of B6's `Latency.kt`.
 *
 * Open the engine on the picked backend, pay the model load once (the warm-up call, excluded from
 * the mean), then embed fixed shopping-list-like documents one at a time and time each call. The
 * reported `backend` is the one the ladder settled on, so a strict `GPU` choice that fell back to
 * CPU cannot be mislabelled (card A6 nit d).
 *
 * Everything device-specific is injected (`open`, `checkModel`, `now`), so the whole pipeline is a
 * plain Jest test with a fake probe and a fake clock: no device, no model, no 484 MB fixture
 * (AGENTS.md). The probe is opened and closed per run — one resident model at a time
 * (RECIPE.md §7.4) — and `device.ts` wires the real `modules/embed` calls.
 */
import type {BackendChoice} from './backend';
import {E_NO_MODEL, PUSH_HINT} from './modelStatus';

/** One timed embed call of the self-test. */
export interface LatencySample {
  text: string;
  /** Wall time of this single `embedDocs([text])` call. */
  millis: number;
}

/** One self-test run: the backend the ladder chose, the load cost and the per-call samples. */
export interface LatencyReport {
  /** The embedder's own backend after the warm-up: `gpu`, `cpu`, `npu` or `none`. */
  backend: string;
  samples: LatencySample[];
  /** Warm-up call = engine load + model open + backend self-test (GPU 3–8 s, CPU 1–2 s). */
  loadMillis: number;
  /** Whether the loaded bundle declares a vision encoder (the scan needs one). */
  supportsImages: boolean;
  /** Matryoshka dims the engine returns (256 today). */
  dims: number;
}

export type SelfTestOutcome =
  | {ok: true; choice: BackendChoice; report: LatencyReport}
  | {
      ok: false;
      choice: BackendChoice;
      /** Stable code shown in the UI: `E_NO_MODEL`, `E_NO_BACKEND`, `E_EMBEDDER`, … */
      code: string;
      message: string;
      /** One line per backend that failed/skipped (NoBackendException.reasons). */
      reasons?: string[];
    };

/** The one method the controller calls (the screen never imports the embedder). */
export interface SelfTestRunner {
  selfTest(choice: BackendChoice): Promise<SelfTestOutcome>;
}

/** Status codes the settings screen renders as-is. */
export const E_NO_BACKEND = 'E_NO_BACKEND';
export const E_EMBEDDER = 'E_EMBEDDER';
/** Model-check failure (re-exported so one import covers the latency card). */
export {E_NO_MODEL};

/** The warm-up text: pays the model open and the ladder's self-test, excluded from the mean. */
export const WARMUP_TEXT = 'warm-up';

/** Three fixed documents in the FLATTEN.md docText shape, so every run measures the same work. */
export const SAMPLE_TEXTS: readonly string[] = [
  'milk',
  'sourdough bread; pan de masa madre; Bakery',
  'cherry tomatoes; tomates cherry; Produce > Vegetables',
];

/** What one run needs from the engine. Read the getters *after* the warm-up (backend settles there). */
export interface EngineProbe {
  readonly backend: string;
  readonly dims: number;
  readonly supportsImages: boolean;
  embedDocs(texts: string[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface SelfTestRunnerOptions {
  /** Opens (and, on the next call, re-opens) the engine under the choice's policy. */
  open: (choice: BackendChoice) => Promise<EngineProbe>;
  /** Optional model-file check before opening — the honest first answer is "no bundle". */
  checkModel?: () => Promise<{present: boolean; path: string}>;
  /** Injectable clock (ms); defaults to `Date.now`. */
  now?: () => number;
  samples?: readonly string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : E_EMBEDDER;
}

function reasonsOf(error: unknown): string[] | undefined {
  const reasons = (error as {reasons?: unknown} | null)?.reasons;
  return Array.isArray(reasons)
    ? reasons.filter((reason): reason is string => typeof reason === 'string')
    : undefined;
}

/**
 * Build the runner over a probe factory. Never throws: a failed run lands in the outcome as
 * `{ok:false, code, message}` so the latency card can render it (B6's `SelfTestResult.Failed`).
 */
export function createSelfTestRunner({
  open,
  checkModel,
  now = Date.now,
  samples = SAMPLE_TEXTS,
}: SelfTestRunnerOptions): SelfTestRunner {
  return {
    async selfTest(choice: BackendChoice): Promise<SelfTestOutcome> {
      if (checkModel !== undefined) {
        try {
          const model = await checkModel();
          if (!model.present) {
            return {
              ok: false,
              choice,
              code: E_NO_MODEL,
              message: `no bundle at ${model.path} — ${PUSH_HINT}`,
            };
          }
        } catch (error) {
          return {ok: false, choice, code: E_NO_MODEL, message: messageOf(error)};
        }
      }

      let probe: EngineProbe | null = null;
      try {
        probe = await open(choice);
        const opened = probe;

        // Warm-up: opens the model, runs the backend self-test, pays the first-call cost.
        const loadStarted = now();
        await opened.embedDocs([WARMUP_TEXT]);
        const loadMillis = Math.max(0, now() - loadStarted);

        const measured: LatencySample[] = [];
        for (const text of samples) {
          const started = now();
          await opened.embedDocs([text]);
          measured.push({text, millis: Math.max(0, now() - started)});
        }

        return {
          ok: true,
          choice,
          report: {
            backend: opened.backend,
            samples: measured,
            loadMillis,
            supportsImages: opened.supportsImages,
            dims: opened.dims,
          },
        };
      } catch (error) {
        return {
          ok: false,
          choice,
          code: codeOf(error),
          message: messageOf(error),
          reasons: reasonsOf(error),
        };
      } finally {
        if (probe !== null) {
          try {
            await probe.close();
          } catch {
            // A failed close after a reported result must not mask the result.
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// formatting — one place so the numbers in tests and on screen agree (B6's LatencyFormat)
// ---------------------------------------------------------------------------------------------

/** Arithmetic mean of the samples; 0 for an empty report. */
export function meanMillis(report: LatencyReport): number {
  if (report.samples.length === 0) {
    return 0;
  }
  return (
    report.samples.reduce((sum, sample) => sum + sample.millis, 0) /
    report.samples.length
  );
}

/** "35 ms", or "1.23 s" from a second up (load times are seconds, embed times milliseconds). */
export function formatMillis(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return safe < 1000
    ? `${Math.round(safe)} ms`
    : `${(safe / 1000).toFixed(2)} s`;
}

/** Per-call mean: one decimal below a second, two above it. */
export function formatMean(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return safe < 1000
    ? `${safe.toFixed(1)} ms`
    : `${(safe / 1000).toFixed(2)} s`;
}

/** "cpu · mean 35.2 ms · 3 calls" — the latency card's second line. */
export function latencyHeadline(report: LatencyReport): string {
  return `${report.backend} · mean ${formatMean(meanMillis(report))} · ${
    report.samples.length
  } calls`;
}

/** "text + image" / "text only (no vision encoder)" — what the loaded bundle can serve. */
export function supportsLine(report: LatencyReport): string {
  return report.supportsImages ? 'text + image' : 'text only (no vision encoder)';
}

/** Fastest/slowest of the samples, or null when none were measured. */
export function sampleRange(
  report: LatencyReport,
): {fastest: number; slowest: number} | null {
  if (report.samples.length === 0) {
    return null;
  }
  const values = report.samples.map(sample => sample.millis);
  return {fastest: Math.min(...values), slowest: Math.max(...values)};
}
