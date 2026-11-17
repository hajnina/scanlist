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
 * the oracle. RANK.md on main currently defines only the 0.02 hysteresis; card S10 is amending the
 * highlight rule (margin M / no-match threshold T and the image-path guard) and will edit this
 * function and nothing else. Ranking order, scores and state must not change then.
 */

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

/** A scored (unchecked) candidate before output formatting. */
export interface RankedCandidate {
  id: string;
  raw: number;
  smoothed: number;
  done: false;
  order: number;
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
 * Barcode normalisation (RANK.md §3.1): NFC, lowercase, trim, every run of Unicode whitespace
 * collapsed to one space. NOTE: `toLowerCase` approximates Python's `casefold` (e.g. "ß" stays
 * "ß" instead of "ss"); same approximation as the Kotlin track, pending S10's RANK.md amendment.
 */
export function normBarcodeText(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/u)
    .filter((part) => part !== "")
    .join(" ");
}

/** Exact (normalised) barcode match against the item name or one of its aliases (RANK.md §3.1). */
export function barcodeMatch(
  item: Pick<RankItem, "name" | "aliases">,
  barcodeName: string | null | undefined,
): boolean {
  if (!barcodeName) return false;
  const target = normBarcodeText(barcodeName);
  if (target === "") return false;
  if (normBarcodeText(item.name) === target) return true;
  return item.aliases.some((alias) => normBarcodeText(alias) === target);
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

/**
 * Pick the highlighted entry: hysteresis, or null when there is no candidate.
 *
 * `candidates` must already be sorted by `sortCandidates`.
 *
 * TODO(S10): RANK.md's next revision adds the margin rule (`top1 - top2 >= M`) and the no-match
 * threshold (`top1 >= T`), plus the image-path guard; the oracle isolates them in this function
 * too. Until that lands, this is exactly the v1 rule: sticky current top unless a challenger is
 * strictly more than 0.02 ahead.
 */
export function decideTop(
  candidates: readonly RankedCandidate[],
  currentTopId: string | null,
): RankedCandidate | null {
  if (candidates.length === 0) return null;
  const best = candidates[0] as RankedCandidate;
  if (currentTopId === null) return best;
  const current = candidates.find((entry) => entry.id === currentTopId);
  if (current === undefined) return best;
  if (
    best.id !== current.id &&
    q6(best.smoothed - current.smoothed) > HYSTERESIS
  ) {
    return best;
  }
  return current;
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
  const candidates: RankedCandidate[] = [];

  for (const { item, vec } of evaluated) {
    // §3: q6 per cosine, max within a source, then max across the sources present.
    let base = -Infinity;
    for (const group of [textQueries, imageQueries]) {
      if (group.length === 0) continue;
      let groupMax = -Infinity;
      for (const query of group) {
        const dot = cosine(vec, query, dims);
        const score = q6(Math.max(-1, Math.min(1, dot)));
        if (score > groupMax) groupMax = score;
      }
      if (groupMax > base) base = groupMax;
    }

    const boost =
      barcodeTarget !== "" && barcodeMatch(item, barcodeTarget) ? BARCODE_BOOST : 0;
    const raw = q6(base + boost);

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
    });
  }

  const sorted = sortCandidates(candidates);
  const top = decideTop(sorted, previous.topId);

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
