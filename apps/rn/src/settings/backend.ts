/**
 * The settings backend picker (card A6) — the React Native twin of the Kotlin track's
 * `BackendChoice.kt` (card B6). Same four options, same ids, same honest mapping onto the embedder
 * ladder every track shares (`shared/android-embed`).
 *
 *  - `auto` — the shipped default: GPU first, CPU fallback. This is exactly what the native ladder
 *    does on its own, so the picker does not invent a second policy.
 *  - `gpu` / `cpu` — strict. The settings probe must report a GPU failure instead of silently
 *    measuring the CPU and labelling it "GPU".
 *  - `npu` — strict **and** experimental (RECIPE.md §7: the SM8750 bundle fails on LiteRT-LM
 *    0.18.1/0.19.1, an uncompiled bundle JIT-compiles for 140–236 s on open). Auto never tries it.
 *
 * Ids are the lowercase strings of the cross-track spec (`auto|gpu|cpu|npu`), so the persisted
 * preference reads the same in all three builds.
 */

/**
 * The **runtime** values the embedder reports (`Embedder.backend` in `shared/android-embed`):
 * `none` before the model is opened / after `close()`.
 *
 * ARCHITECTURE.md's "Embedding backends" contract lists `npu|gpu|cpu|server|wasm` — it has neither
 * `none` nor the RN settings `auto` choice, and Track C is the only track with a `server` backend.
 * This type is the reconciled one for Track A (card A6 nit d); the doc line is outside this card's
 * `owns:` and is reported in the PR instead of edited. `EmbedBackend` in
 * `apps/rn/modules/embed` already declares exactly these four runtime values.
 */
export type NativeBackend = 'npu' | 'gpu' | 'cpu' | 'none';

/** What the picker persists: a preference, not a reported backend (`auto` is not a backend). */
export type BackendChoice = 'auto' | 'gpu' | 'cpu' | 'npu';

export interface BackendOption {
  id: BackendChoice;
  /** Chip label; experimental options add "· experimental" in the picker. */
  label: string;
  experimental: boolean;
  /** The exact ladder this choice asks the embedder to try, in order. */
  candidates: readonly NativeBackend[];
  /** What selecting this option attempts, for the picker's one-line explanation. */
  ladderLabel: string;
}

/**
 * The four options in picker order. Object form (not an enum) so the UI maps over it and the ids
 * stay literal types the store can validate.
 */
export const BACKEND_OPTIONS: readonly BackendOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    experimental: false,
    candidates: ['gpu', 'cpu'],
    ladderLabel: 'GPU → CPU fallback',
  },
  {
    id: 'gpu',
    label: 'GPU',
    experimental: false,
    candidates: ['gpu'],
    ladderLabel: 'GPU only',
  },
  {
    id: 'cpu',
    label: 'CPU',
    experimental: false,
    candidates: ['cpu'],
    ladderLabel: 'CPU only',
  },
  {
    id: 'npu',
    label: 'NPU',
    experimental: true,
    candidates: ['npu'],
    ladderLabel: 'NPU only · experimental',
  },
];

/** Never chosen = the shipped GPU→CPU ladder. */
export const DEFAULT_BACKEND: BackendChoice = 'auto';

const BY_ID = new Map<BackendChoice, BackendOption>(
  BACKEND_OPTIONS.map(option => [option.id, option]),
);

export function backendOption(choice: BackendChoice): BackendOption {
  // Every BackendChoice has an option; the fallback keeps a corrupt caller from crashing the UI.
  return BY_ID.get(choice) ?? BY_ID.get(DEFAULT_BACKEND)!;
}

export function backendCandidates(
  choice: BackendChoice,
): readonly NativeBackend[] {
  return backendOption(choice).candidates;
}

/** "GPU → CPU fallback" for the picker's explanation line. */
export function ladderLabel(choice: BackendChoice): string {
  return backendOption(choice).ladderLabel;
}

export function isBackendChoice(value: unknown): value is BackendChoice {
  return (
    value === 'auto' || value === 'gpu' || value === 'cpu' || value === 'npu'
  );
}

export function isNativeBackend(value: unknown): value is NativeBackend {
  return (
    value === 'npu' || value === 'gpu' || value === 'cpu' || value === 'none'
  );
}

/**
 * Never throws: a missing, unknown or wrongly-typed persisted id (or a native value) falls back to
 * `auto`. Trimmed + lowercased like B6's `fromId`, so `" GPU "` is accepted.
 */
export function parseBackendChoice(value: unknown): BackendChoice {
  if (typeof value !== 'string') {
    return DEFAULT_BACKEND;
  }
  const id = value.trim().toLowerCase();
  return isBackendChoice(id) ? id : DEFAULT_BACKEND;
}

/** A native backend string from the bridge, or `none` when it is absent/unknown. */
export function parseNativeBackend(value: unknown): NativeBackend {
  return isNativeBackend(value) ? value : 'none';
}

/**
 * "Auto — GPU → CPU fallback · active CPU" after a run; the active half is omitted before the
 * engine has opened (`none`). The picker and the latency card both read this one line.
 */
export function backendSummary(
  choice: BackendChoice,
  reported?: NativeBackend,
): string {
  const option = backendOption(choice);
  const selected = `${option.label} — ${option.ladderLabel}`;
  return reported === undefined || reported === 'none'
    ? selected
    : `${selected} · active ${reported.toUpperCase()}`;
}

/** Whether the reported runtime backend is consistent with what the choice asked for. */
export function matchesChoice(
  reported: NativeBackend,
  choice: BackendChoice,
): boolean {
  return reported !== 'none' && backendCandidates(choice).includes(reported);
}
