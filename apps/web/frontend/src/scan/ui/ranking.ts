/**
 * Rank-tick glue + view models (card C5).
 *
 * The hero decision is **not** here: `evaluateTick` hands the pool to ts-core's `rank()`, which owns
 * cosine scoring, max-fusion, the barcode boost, EMA smoothing, hysteresis, the evidence gates and
 * the image accept-list guard, and returns `topId` (nullable) plus the full ordered `entries`.
 * `toRows` only re-labels that output for the DOM; it never re-decides or re-sorts the hero.
 */

import { docText, rank } from "@scanlist/ts-core";
import type {
  FlattenedItem,
  FloatVector,
  RankItem,
  RankOutput,
} from "@scanlist/ts-core";

import { displayName, displayNote, displayText } from "../../core/display";
import type { QueryPool } from "./pool";

/** One rendered row: the hero card and the ranked list share this shape. */
export interface ScanRow {
  id: string;
  name: string;
  /** `displayText` (amount + unit), "" when absent. */
  amount: string;
  note: string | null;
  done: boolean;
  /** Smoothed score from the ranker; `null` for done rows and unranked output. */
  score: number | null;
  /** True for exactly the entry ts-core returned as `topId` (never recomputed here). */
  isHero: boolean;
}

export interface ScanTableView {
  ranked: boolean;
  hero: ScanRow | null;
  rows: ScanRow[];
}

export interface SourceChipView {
  key: "barcode" | "off" | "ocr" | "image" | "queries";
  label: string;
  detail: string;
  active: boolean;
}

/** Flattened items + their doc vectors → the ranker's `RankItem[]` (missing vector stays `null`). */
export function buildRankItems(
  items: readonly FlattenedItem[],
  vectors: ReadonlyMap<string, FloatVector>,
): RankItem[] {
  return items.map((item) => ({ ...item, vec: vectors.get(item.id) ?? null }));
}

export interface TickInput {
  items: readonly FlattenedItem[];
  itemVectors: ReadonlyMap<string, FloatVector>;
  /** Raw pool texts in slot order (barcode first), vectors only for the ones already embedded. */
  textVectors: ReadonlyMap<string, FloatVector>;
  /** Pool texts in slot order — vectors are looked up here, so order is preserved. */
  texts: readonly string[];
  /** Image query vectors (already `ImageEmbedding.vector`), newest-window filtered by the caller. */
  imageVectors: readonly FloatVector[];
  prev: RankOutput | null;
  barcodeName: string | null;
}

/**
 * One pure rank tick. Text vectors follow the pool's slot order (barcode first); vectors not yet
 * embedded are simply absent this tick (the controller asks for them in the background and re-ticks).
 */
export function evaluateTick(input: TickInput): RankOutput {
  const text: FloatVector[] = [];
  for (const raw of input.texts) {
    const vector = input.textVectors.get(raw);
    if (vector !== undefined) text.push(vector);
  }

  return rank(
    buildRankItems(input.items, input.itemVectors),
    { text, image: [...input.imageVectors] },
    input.prev,
    input.barcodeName,
    { prevOutput: input.prev },
  );
}

/** Map `rank()` output onto rows, preserving its order. `hero` is `entries[topId]` or null. */
export function toRows(
  output: RankOutput,
  items: readonly FlattenedItem[],
): ScanTableView {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows: ScanRow[] = [];

  for (const entry of output.entries) {
    const item = byId.get(entry.id);
    if (item === undefined) continue; // an output from another list: never render a ghost row
    rows.push({
      id: entry.id,
      name: displayName(item),
      amount: displayText(item),
      note: displayNote(item),
      done: entry.done,
      score: entry.smoothed,
      isHero: output.topId !== null && entry.id === output.topId,
    });
  }

  return {
    ranked: output.ranked,
    hero: rows.find((row) => row.isHero) ?? null,
    rows,
  };
}

/** Score rendered as a two-decimal similarity (RANK.md scores are q6 cosines). */
export function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return score.toFixed(2);
}

/**
 * Live source chips (B5/A5 parity: informational only, no per-source weighting — RANK.md §2.2).
 * The chips describe the *pool*, so the user can see why the hero changed (or why there is none).
 */
export function sourceChips(pool: QueryPool, maxTextQueries: number): SourceChipView[] {
  const barcode = pool.barcode;
  const barcodeText = barcode?.text?.trim() ?? "";
  const offState =
    barcode === null
      ? null
      : barcode.state === "pending"
        ? "pending"
        : barcodeText !== ""
          ? "found"
          : "none";
  const ocrCount = pool.texts.length - (pool.barcodeInPool ? 1 : 0);

  return [
    {
      key: "barcode",
      label: "BARCODE",
      detail: barcode === null ? "—" : barcode.barcode,
      active: barcode !== null,
    },
    {
      key: "off",
      label: "OFF",
      detail: offState === null ? "—" : offState,
      active: barcodeText !== "",
    },
    {
      key: "ocr",
      label: "OCR",
      detail: ocrCount === 0 ? "—" : `${ocrCount} line${ocrCount === 1 ? "" : "s"}`,
      active: ocrCount > 0,
    },
    {
      key: "image",
      label: "IMAGE",
      detail: pool.images.length === 0 ? "—" : `${pool.images.length} frame${pool.images.length === 1 ? "" : "s"}`,
      active: pool.images.length > 0,
    },
    {
      key: "queries",
      label: "QUERIES",
      detail: `${pool.texts.length}/${maxTextQueries}`,
      active: pool.texts.length > 0 || pool.images.length > 0,
    },
  ];
}

/** The hero's OFF/score status line, honest about the null case (RANK.md §6.2 gates). */
export function heroStatus(hero: ScanRow | null, ranked: boolean): string {
  if (hero !== null) return `similarity ${formatScore(hero.score)} · never auto-ticked`;
  if (!ranked) return "Point the camera at a shelf or an item to start ranking.";
  return "Nothing is a confident match yet — keep scanning or tick from the list.";
}

/** Item ids whose doc vector is still missing (RANK.md §8 defers the tick while any is null). */
export function missingItemVectors(
  items: readonly FlattenedItem[],
  vectors: ReadonlyMap<string, FloatVector>,
): string[] {
  const missing: string[] = [];
  for (const item of items) {
    if (!vectors.has(item.id)) missing.push(item.id);
  }
  return missing;
}

/** Doc-embedding text for every item, in FLATTEN.md order (what `POST /embed/text` is asked for). */
export function docTextsOf(items: readonly FlattenedItem[]): string[] {
  return items.map((item) => docText(item));
}
