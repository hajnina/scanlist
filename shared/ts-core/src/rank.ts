/**
 * Ranking: cosine scores, max-fusion, barcode boost, EMA smoothing, hysteresis and output order —
 * RANK.md §1–§9. This is a line-for-line port of the Python oracle
 * (`shared/ref/scanlist_ref.py`), because `shared/fixtures/golden.json` compares the two exactly.
 *
 * The ranker is pure: no I/O, no model, no timers. `vec` lives on the input items only; query
 * vectors are already prefixed/embedded by the caller. Every stored or compared score goes through
 * `q6` at 6 dp, which makes float-order noise irrelevant (RANK.md §5).
 *
 * Highlight coordination: the only place the hero/top decision lives is `decideTop`, exactly as in
 * the oracle (RANK.md §6.1–§6.4): hysteresis picks the hero, the per-source evidence gate decides
 * whether it is worth showing, and an image-driven hero additionally needs accept-list confirmation.
 * `topId` is the highlight and may be null while `entries` keeps the full ranked order. Ranking,
 * scores and state never depend on the outcome.
 */

import { casefold } from "./casefold";
import type {
  FloatVector,
  RankEntry,
  RankItem,
  RankOptions,
  RankOutput,
  RankPrevious,
  RankQueries,
  RankState,
} from "./types";

// --- RANK.md constants (v1 defaults, not calibrated; card X1 revises) -----------------------
export const DIMS_ACTIVE = 256;
export const EMA_ALPHA = 0.5;
export const HYSTERESIS = 0.02;
export const MIN_INTERVAL_MS = 400;
export const BARCODE_BOOST = 0.15;
export const MAX_TEXT_QUERIES = 16;

// --- RANK.md §6.2 highlight gates (S10, calibrated on golden.json; card X1 re-fits) -----------
export const MARGIN_TEXT = 0.05;
export const NO_MATCH_TEXT = 0.79;
export const MARGIN_IMAGE = 0.005;
export const NO_MATCH_IMAGE = 0.68;

/** Which query source produced a candidate's base score (§3); a tie counts as `"text"`. */
export type CandidateSource = "text" | "image";

/** A scored (unchecked) candidate before output formatting. */
export interface RankedCandidate {
  id: string;
  raw: number;
  smoothed: number;
  done: false;
  order: number;
  /**
   * Source that produced this candidate's `base` score (RANK.md §3/§6.2). Absent means `"text"`,
   * mirroring the oracle's `entry.get("source", "text")`.
   */
  source?: CandidateSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical 6-decimal rounding, half away from zero (RANK.md §5). Non-finite input is not a score
 * and degrades to 0.0 (§8); negative zero normalises to +0.
 */
export function q6(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x === 0) return 0;
  const rounded = Math.floor(Math.abs(x) * 1e6 + 0.5) / 1e6;
  const signed = x < 0 ? -rounded : rounded;
  return signed === 0 ? 0 : signed;
}

/** Dot product of two same-length vectors, accumulating in ascending index order (§2/§5). */
export function cosine(a: FloatVector, b: FloatVector, dims = DIMS_ACTIVE): number {
  let sum = 0;
  for (let i = 0; i < dims; i += 1) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

/**
 * Barcode normalisation (RANK.md §3.1): NFC, Unicode **full** case folding (`casefold.ts`; the
 * semantics of Python's `str.casefold()`), trim, every run of Unicode whitespace collapsed to one
 * space. `toLowerCase` alone is not full folding — `ß` must become `ss`.
 */
export function normBarcodeText(s: string): string {
  return casefold(s.normalize("NFC"))
    .split(/\s+/u)
    .filter((part) => part !== "")
    .join(" ");
}

/** Exact match against an already-normalised (`normBarcodeText`) target — the oracle's helper. */
function matchesNormalised(
  item: Pick<RankItem, "name" | "aliases">,
  target: string,
): boolean {
  if (normBarcodeText(item.name) === target) return true;
  return item.aliases.some((alias) => normBarcodeText(alias) === target);
}

/** Exact (normalised) barcode match against the item name or one of its aliases (RANK.md §3.1). */
export function barcodeMatch(
  item: Pick<RankItem, "name" | "aliases">,
  barcodeName: string | null | undefined,
): boolean {
  if (!barcodeName) return false;
  const target = normBarcodeText(barcodeName);
  if (target === "") return false;
  return matchesNormalised(item, target);
}

function isValidVector(value: unknown, dims: number): value is FloatVector {
  if (!Array.isArray(value) || value.length !== dims) return false;
  for (let i = 0; i < dims; i += 1) {
    const component = value[i];
    if (typeof component !== "number" || !Number.isFinite(component)) return false;
  }
  return true;
}

function cleanQueryGroup(raw: unknown, dims: number): number[][] {
  if (raw === null || raw === undefined || !Array.isArray(raw)) return [];
  const out: number[][] = [];
  for (const vector of raw) {
    if (isValidVector(vector, dims)) out.push([...vector]);
  }
  return out;
}

function prepareQueries(
  queries: RankQueries | null | undefined,
  dims: number,
): { text: number[][]; image: number[][] } {
  if (queries === null || queries === undefined) return { text: [], image: [] };
  if (!isRecord(queries)) {
    throw new TypeError("queries must be an object with 'text' and/or 'image' arrays");
  }
  const text = cleanQueryGroup(queries.text, dims);
  const image = cleanQueryGroup(queries.image, dims);
  if (text.length > MAX_TEXT_QUERIES) text.length = MAX_TEXT_QUERIES;
  return { text, image };
}

/** Accept a state, a whole rank output, a bare `{id: score}` map, or nothing (RANK.md §1). */
function normalisePrev(prev: RankPrevious): {
  smoothed: Map<string, number>;
  topId: string | null;
} {
  if (prev === null || prev === undefined) return { smoothed: new Map(), topId: null };
  if (!isRecord(prev)) {
    throw new TypeError("prev must be a state, a rank output or an {id: score} map");
  }

  if ("state" in prev && isRecord(prev["state"])) {
    return normalisePrev(prev["state"] as unknown as RankState);
  }

  const smoothed = new Map<string, number>();
  if ("smoothed" in prev || "topId" in prev) {
    const raw = prev["smoothed"];
    if (isRecord(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== "number" && typeof value !== "string") continue;
        const numeric = Number(value);
        if (Number.isFinite(numeric)) smoothed.set(key, q6(numeric));
      }
    }
    const top = prev["topId"];
    return { smoothed, topId: top === null || top === undefined ? null : String(top) };
  }

  // Bare previous scores: {itemId: smoothed}.
  for (const [key, value] of Object.entries(prev)) {
    if (typeof value !== "number" && typeof value !== "string") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) smoothed.set(key, q6(numeric));
  }
  return { smoothed, topId: null };
}

function isDone(item: RankItem): boolean {
  return Boolean(item.done);
}

/** §8 row 1: flatten order, no scores, empty state. */
export function unranked(items: readonly RankItem[]): RankOutput {
  return {
    ranked: false,
    topId: null,
    entries: items.map((item) => ({
      id: item.id,
      raw: null,
      smoothed: null,
      done: isDone(item),
    })),
    state: { smoothed: {}, topId: null },
  };
}

/** §6: sort by smoothed descending, then flatten `order` ascending (stable). */
export function sortCandidates(
  candidates: readonly RankedCandidate[],
): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.smoothed !== b.smoothed) return b.smoothed - a.smoothed;
    return a.order - b.order;
  });
}

const NO_CONFIRMED_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Pick the highlighted entry, or null for "no hero" (RANK.md §6.1–§6.3), in the oracle's exact
 * order: hysteresis → evidence gate → image guard. `candidates` must already be sorted by
 * `sortCandidates`.
 *
 * 1. **Hysteresis (§6.1)** chooses the hero: the previous hero is sticky while a challenger is
 *    ahead by at most `HYSTERESIS`. A hero inside the dead band may be slightly *behind* the
 *    sorted top-1 — that is why the gate below measures the margin on the sorted top pair but the
 *    floor on the hero itself.
 * 2. **Evidence gate (§6.2)**: `q6(top1 − top2) >= M` (vacuous with fewer than two candidates) and
 *    `q6(hero) >= T`, with `(M, T)` chosen by the *hero's* driving source — text `(0.05, 0.79)`,
 *    image `(0.005, 0.68)`; absent `source` means text, the stricter gate.
 * 3. **Image guard (§6.3, v1 accept-list)**: an image-driven hero must be in
 *    `barcodeConfirmedIds`, i.e. `barcodeMatch(hero, barcodeName)` was true this tick.
 *
 * `state.topId` mirrors the result; when null the caller keeps the full ranked order in `entries`.
 */
export function decideTop(
  candidates: readonly RankedCandidate[],
  currentTopId: string | null = null,
  barcodeConfirmedIds: ReadonlySet<string> = NO_CONFIRMED_IDS,
): RankedCandidate | null {
  if (candidates.length === 0) return null;

  const best = candidates[0] as RankedCandidate;
  const runnerUp = candidates.length > 1 ? (candidates[1] as RankedCandidate) : undefined;

  // 1. Hysteresis: keep the current hero while the challenger is inside the dead band.
  let hero = best;
  if (currentTopId !== null) {
    const current = candidates.find((entry) => entry.id === currentTopId);
    if (
      current !== undefined &&
      !(best.id !== current.id && q6(best.smoothed - current.smoothed) > HYSTERESIS)
    ) {
      hero = current;
    }
  }

  // 2. Evidence gate: decisive against the runner-up AND plausible on its own.
  const imageDriven = (hero.source ?? "text") === "image";
  const marginRequired = imageDriven ? MARGIN_IMAGE : MARGIN_TEXT;
  const floorRequired = imageDriven ? NO_MATCH_IMAGE : NO_MATCH_TEXT;
  if (
    runnerUp !== undefined &&
    q6(best.smoothed - runnerUp.smoothed) < marginRequired
  ) {
    return null;
  }
  if (q6(hero.smoothed) < floorRequired) return null;

  // 3. Image guard: an image-only winner needs independent accept-list confirmation.
  if (imageDriven && !barcodeConfirmedIds.has(hero.id)) return null;

  return hero;
}

/** §3: q6 per cosine, then the max within one source (`-Infinity` when the source is absent). */
function sourceMax(
  vec: FloatVector,
  group: readonly FloatVector[],
  dims: number,
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const query of group) {
    const score = q6(Math.max(-1, Math.min(1, cosine(vec, query, dims))));
    if (score > best) best = score;
  }
  return best;
}

/**
 * Score, smooth and order one evaluation tick (RANK.md §1/§9).
 *
 * `items` are flattened in JSON order, each carrying its final 256-d vector or null; `queries` is
 * `{text, image}`; `prev` is the previous state (persist the returned `state`); `barcodeName` is
 * the already-resolved OFF product name or null. `options.prevOutput` is the caller's cached last
 * output, returned unchanged when an unchecked item is still missing its vector (§8).
 */
export function rank(
  items: readonly RankItem[],
  queries?: RankQueries | null,
  prev?: RankPrevious,
  barcodeName?: string | null,
  options?: RankOptions,
): RankOutput {
  const dims = options?.dims ?? DIMS_ACTIVE;
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new RangeError(`dims must be a positive integer, got ${String(dims)}`);
  }

  const previous = normalisePrev(prev);
  const { text: textQueries, image: imageQueries } = prepareQueries(queries, dims);

  // §8 row 1: no signal at all -> unranked, state cleared.
  if (textQueries.length === 0 && imageQueries.length === 0) {
    return unranked(items);
  }

  const evaluated: { item: RankItem; vec: FloatVector }[] = [];
  let missingVector = false;
  for (const item of items) {
    if (isDone(item)) continue;
    if (!isValidVector(item.vec, dims)) {
      missingVector = true;
      continue;
    }
    evaluated.push({ item, vec: item.vec });
  }

  if (missingVector) {
    // §8 "some item vectors missing": keep the previous output and leave state untouched.
    const state: RankState = {
      smoothed: Object.fromEntries(previous.smoothed),
      topId: previous.topId,
    };
    if (options?.prevOutput) {
      return { ...options.prevOutput, state };
    }
    return { ...unranked(items), state };
  }

  const doneEntries: RankEntry[] = items
    .filter(isDone)
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((item) => ({ id: item.id, raw: null, smoothed: null, done: true }));

  // All items checked (or zero items): ranked, but nothing to highlight.
  if (evaluated.length === 0) {
    return {
      ranked: true,
      topId: null,
      entries: doneEntries,
      state: { smoothed: {}, topId: null },
    };
  }

  const barcodeTarget =
    barcodeName !== null && barcodeName !== undefined && barcodeName !== ""
      ? normBarcodeText(barcodeName)
      : "";

  const smoothedById = new Map<string, number>();
  const confirmedIds = new Set<string>();
  const candidates: RankedCandidate[] = [];

  for (const { item, vec } of evaluated) {
    // §3: q6 per cosine, max within a source, then max across the sources present. The per-source
    // maxima are kept because §6.2 picks M/T from the source that drove the winner (tie → text).
    const textMax = sourceMax(vec, textQueries, dims);
    const imageMax = sourceMax(vec, imageQueries, dims);
    const base = Math.max(textMax, imageMax);
    const source: CandidateSource = imageMax > textMax ? "image" : "text";

    const confirmed = barcodeTarget !== "" && matchesNormalised(item, barcodeTarget);
    if (confirmed) confirmedIds.add(item.id);
    const raw = q6(base + (confirmed ? BARCODE_BOOST : 0));

    const previousScore = previous.smoothed.get(item.id);
    const smoothed =
      previousScore === undefined
        ? raw
        : q6(EMA_ALPHA * raw + (1 - EMA_ALPHA) * previousScore);

    smoothedById.set(item.id, smoothed);
    candidates.push({
      id: item.id,
      raw,
      smoothed,
      done: false,
      order: item.order,
      source,
    });
  }

  const sorted = sortCandidates(candidates);
  const top = decideTop(sorted, previous.topId, confirmedIds);

  let ordered: RankedCandidate[];
  if (top === null) {
    ordered = sorted;
  } else if ((sorted[0] as RankedCandidate).id === top.id) {
    ordered = sorted;
  } else {
    ordered = [top, ...sorted.filter((entry) => entry.id !== top.id)];
  }

  const entries: RankEntry[] = ordered.map((entry) => ({
    id: entry.id,
    raw: entry.raw,
    smoothed: entry.smoothed,
    done: false,
  }));
  entries.push(...doneEntries);

  const state: RankState = {
    smoothed: Object.fromEntries(smoothedById),
    topId: top === null ? null : top.id,
  };
  return { ranked: true, topId: state.topId, entries, state };
}
