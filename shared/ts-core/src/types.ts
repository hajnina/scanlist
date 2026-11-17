/**
 * TypeScript contract for the shared ScanList core.
 *
 * `ScanList` / `ScanListSection` / `ScanListItem` / `ScanListAmount` are a field-for-field mirror of
 * `apps/rn/src/list/types.ts` (card A1) and `shared/spec/list.schema.json` (card S1). Keep them in
 * sync with the RN package: the two tracks share the JSON shape, not an implementation.
 *
 * `FlattenedItem` is the exact FLATTEN.md §1 output shape (the golden fixture compares it byte for
 * byte), `RankItem` adds the optional vector that RANK.md §1 puts on the *input* copy only, and
 * `RankOutput` is the RANK.md §1 result.
 */

/** `amount` may be absent, a number (2, 0.5) or free text ("2 packs"); `unit` and `note` are their own fields. */
export type ScanListAmount = number | string;

/** Item: `name` is the only required field; `id` is optional — a sha1 id is derived when absent. */
export interface ScanListItem {
  id?: string;
  name: string;
  amount?: ScanListAmount;
  unit?: string;
  note?: string;
  /** Extra words embedded with the item (brand, other language), e.g. "coke" -> "Coca-Cola". */
  aliases?: string[];
  /** `done: true` items sink into the collapsed "Done" group. */
  done?: boolean;
}

/** Section: only `name` is required; sub-sections nest recursively, any depth. */
export interface ScanListSection {
  name: string;
  items?: ScanListItem[];
  sections?: ScanListSection[];
}

/** List document root: `title` + `sections` required, `version` optional (schema default 1). */
export interface ScanList {
  title: string;
  version?: number;
  sections: ScanListSection[];
}

/**
 * One item flattened out of the tree (FLATTEN.md §1). Field names and types are normative:
 * the S3 golden fixture stores exactly this object (and no `vec` key).
 */
export interface FlattenedItem {
  /** Explicit id (trimmed verbatim) or `sha1:` + sha1(path/name#index); unique in the list. */
  id: string;
  /** `item.name`, trimmed for display; the id key uses the verbatim value. */
  name: string;
  amount: ScanListAmount | null;
  unit: string | null;
  note: string | null;
  /** Non-empty trimmed aliases, deduped case-insensitively after NFC (FLATTEN.md §5). */
  aliases: string[];
  done: boolean;
  /** Section names root -> parent section, `[]` for a root item. */
  path: string[];
  /** `path.join(" > ")`, `""` for a root item. */
  pathText: string;
  /** 0-based index of the item in its parent section's `items`. */
  index: number;
  /** 0-based index in the flattened output (JSON order). */
  order: number;
}

/** A float64 vector; production value is 256-d (RANK.md §2). */
export type FloatVector = readonly number[];

/** Flattened item plus the already-truncated, L2-normalised item vector (RANK.md §1). */
export interface RankItem extends FlattenedItem {
  /** `null`/absent means "not embedded yet": the tick is deferred (RANK.md §8). */
  vec?: FloatVector | null;
}

/** Query vectors: text ones are prefixed+embedded by the caller, image ones carry no prefix. */
export interface RankQueries {
  text?: readonly FloatVector[] | null;
  image?: readonly FloatVector[] | null;
}

/** Persisted ranker state between ticks (RANK.md §1/§4). */
export interface RankState {
  smoothed: Record<string, number>;
  topId: string | null;
}

/** One rendered entry (RANK.md §1); checked items have `raw`/`smoothed` null. */
export interface RankEntry {
  id: string;
  raw: number | null;
  smoothed: number | null;
  done: boolean;
}

/** The pure ranker's result for one evaluation tick. */
export interface RankOutput {
  ranked: boolean;
  topId: string | null;
  entries: RankEntry[];
  state: RankState;
}

/** Previous state: a `RankState`, a whole `RankOutput`, or a bare `{itemId: smoothed}` map. */
export type RankPrevious =
  | RankState
  | RankOutput
  | Record<string, number>
  | null
  | undefined;

/** Options for `rank`; `prevOutput` is the caller's cached output (RANK.md §8 "vectors missing"). */
export interface RankOptions {
  prevOutput?: RankOutput | null;
  /** Active dimensions; 256 in production (4 is handy for the RANK.md §10 worked example). */
  dims?: number;
}
