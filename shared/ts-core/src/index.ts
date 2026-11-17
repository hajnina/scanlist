/**
 * `@scanlist/ts-core` — the shared, platform-neutral ScanList core.
 *
 * - `parseList` validates the LIST.md JSON shape and reports RFC 6901 pointer errors.
 * - `flatten` / `docText` implement FLATTEN.md (ids, order, embedding text).
 * - `rank` implements RANK.md (cosine, max-fusion, barcode boost, EMA, per-source highlight gates,
 *   image accept-list guard, ordering), and `casefold` is the shared Unicode full folding used by
 *   both barcode/OFF name matching and alias dedupe.
 *
 * Zero runtime dependencies, ESM, no React and no I/O, so React Native and the web app can import
 * the same code. The golden fixture (`shared/fixtures/golden.json`) pins behaviour to the S2
 * Python oracle.
 */

export type {
  FloatVector,
  FlattenedItem,
  RankEntry,
  RankItem,
  RankOptions,
  RankOutput,
  RankPrevious,
  RankQueries,
  RankState,
  ScanList,
  ScanListAmount,
  ScanListItem,
  ScanListSection,
} from "./types";

export type { ParseListResult } from "./parse";
export { errorsOf, parseList } from "./parse";

export { casefold } from "./casefold";
export { docText, docTexts, flatten } from "./flatten";
export { sha1Hex } from "./sha1";

export {
  BARCODE_BOOST,
  DIMS_ACTIVE,
  EMA_ALPHA,
  HYSTERESIS,
  MARGIN_IMAGE,
  MARGIN_TEXT,
  MAX_TEXT_QUERIES,
  MIN_INTERVAL_MS,
  NO_MATCH_IMAGE,
  NO_MATCH_TEXT,
  barcodeMatch,
  cosine,
  decideTop,
  normBarcodeText,
  q6,
  rank,
  sortCandidates,
  unranked,
} from "./rank";
export type { CandidateSource, RankedCandidate } from "./rank";
