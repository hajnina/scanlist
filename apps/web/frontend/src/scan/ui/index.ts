/**
 * Web scan UI (card C5) — public surface.
 *
 * `ScanScreen` is what the app mounts; everything else is exported for the tests (and for the
 * desktop-webcam manual check) so the pool-order/hero-gate wiring can be driven without a camera:
 *
 *   pool.ts          evidence windows + barcode-first 16-slot pool (RANK.md §2.2)
 *   ranking.ts       buildRankItems/evaluateTick/toRows/sourceChips around ts-core rank()
 *   controller.ts    evidence → pool → embeddings → rank → ScanUiState (never commits)
 *   textEmbedder.ts  POST /embed/text client + the synchronous EmbedPort seam
 *   offClient.ts     GET /off/{barcode} client (server-cached; query_text is the boost input)
 *   prompts.ts       prompts.json prefixes read from the spec file (never hard-coded)
 *   items.ts         flattened id → original ScanListItem (C2's commit path)
 *   flip.ts          FLIP measure/invert/play maths
 *   vibrate.ts       navigator.vibrate with the graceful no-vibrate path
 */

export { ScanScreen, SCAN_TICK_INTERVAL_MS } from "./ScanScreen";
export type { ScanScreenProps } from "./ScanScreen";
export { ScanResults } from "./ScanResults";
export type { ScanResultsProps } from "./ScanResults";

export {
  BARCODE_TTL_MS,
  IMAGE_WINDOW_MS,
  MAX_IMAGE_VECTORS,
  OCR_LINE_TTL_MS,
  DEFAULT_POOL_LIMITS,
  assembleQueryPool,
  imageWindow,
  liveBarcode,
  liveOcrLines,
} from "./pool";
export type {
  BarcodeEvidence,
  ImageEvidence,
  OcrLineEvidence,
  PoolLimits,
  QueryPool,
} from "./pool";

export { buildRankItems, evaluateTick, toRows, sourceChips, formatScore, heroStatus } from "./ranking";
export type { ScanRow, ScanTableView, SourceChipView, TickInput } from "./ranking";

export { createScanController } from "./controller";
export type { ScanController, ScanControllerOptions, ScanUiState } from "./controller";

export { createHttpEmbedPort, embedTexts, TextEmbedError } from "./textEmbedder";
export type { EmbedPort, EmbedResolution } from "./textEmbedder";

export { createHttpOffPort, offQueryText } from "./offClient";
export type { OffPort, OffResolution, OffState } from "./offClient";

export { PROMPT_PREFIXES, applyPrefix, readPrefixes } from "./prompts";
export type { RetrievalPrefixes } from "./prompts";

export { itemById, originalItems } from "./items";

export {
  FLIP_DURATION_MS,
  FLIP_EASING,
  FLIP_MIN_DELTA_PX,
  capturePositions,
  computeFlip,
  flipTransform,
  playFlip,
  prefersReducedMotion,
  shouldAnimateFlip,
} from "./flip";
export type { FlipMove, Measurable } from "./flip";

export {
  VIBRATE_HERO,
  VIBRATE_REJECT,
  VIBRATE_START,
  VIBRATE_TICK,
  heroHaptic,
  rejectHaptic,
  startHaptic,
  tickHaptic,
  vibrate,
} from "./vibrate";
export type { VibrateTarget } from "./vibrate";

export type { RectLike } from "./types";
