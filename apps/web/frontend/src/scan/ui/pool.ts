/**
 * Query-pool assembly (card C5): what one rank tick is allowed to look at.
 *
 * RANK.md §2.2 is the normative shape, and this module is where the C5 wiring decision from the lead
 * note lives:
 *
 *  - **Barcode first.** A barcode and up to 16 OCR lines can be live at once, but the ranker takes
 *    only the first 16 text queries (`MAX_TEXT_QUERIES`) and drops the rest in ARRIVAL order. A
 *    barcode signal can legitimately arrive last (the camera finds the code after the label text),
 *    which would push it out of the pool and silently lose the +0.15 boost. So the barcode query text
 *    is always slot 0 and OCR lines are capped at `MAX_TEXT_QUERIES - 1` while it is live — exactly
 *    the "prepend the barcode signal or cap OCR at 15" option the card allows, implemented on the
 *    client side with no rank-side change (documented in the card Notes / PR).
 *  - **Per-line OCR queries.** C4 emits one signal per line, newest `at` on repeats. The UI keeps a
 *    line for `OCR_LINE_TTL_MS` after it was last seen (slightly longer than the source's 2 s repeat
 *    window) so a line that stays in shot keeps its slot, and drops it once the camera moves on.
 *  - **Barcode lifetime.** `DEFAULT_BARCODE_HOLD_MS` (4 s), the same hold C4/A4 use to de-duplicate.
 *  - **Image window.** At most the 4 most recent image vectors from the last 2000 ms (RANK.md §2.2).
 *    The sources emit an image marker only when its vector lands, so the marker is not evidence on
 *    its own; only `ImageEvidence` participates.
 *
 * Nothing here decides the hero: `rank()`/`decideTop()` in ts-core does, from this pool. Empty pool →
 * `rank()` returns "unranked" and the UI renders its honest null state.
 */

import { MAX_TEXT_QUERIES } from "@scanlist/ts-core";

import { DEFAULT_BARCODE_HOLD_MS } from "../sources/dedupe";
import type { ScanSignal } from "../sources/types";

/** RANK.md §2.2: "up to the 4 most recent image vectors from the last 2000 ms". */
export const IMAGE_WINDOW_MS = 2000;
export const MAX_IMAGE_VECTORS = 4;

/**
 * How long an OCR line stays in the pool after its last signal. C4's repeat window is 2000 ms
 * (`DEFAULT_OCR_LINE_REPEAT_MS`), so 2500 ms means a line still in view is refreshed before it can
 * fall out, while a line that left the frame is dropped within one scan pass.
 */
export const OCR_LINE_TTL_MS = 2500;

/** The barcode hold used by A4/C4, reused as the pool lifetime (one constant, one meaning). */
export const BARCODE_TTL_MS = DEFAULT_BARCODE_HOLD_MS;

export type BarcodeLookupState = "pending" | "found" | "none" | "error";

/**
 * One barcode seen by the scan session, with the OFF result once it resolves.
 * `text` is OFF.md §3's derived query text (already the raw product name — the caller applies the
 * prompts.json query prefix at the embedding boundary), `null` when OFF has no usable name.
 */
export interface BarcodeEvidence {
  barcode: string;
  /** `Date.now()` of the latest barcode signal for this value. */
  at: number;
  /** `null` while pending, and permanently for a hit with no usable name. */
  text: string | null;
  state: BarcodeLookupState;
  /** Human-readable reason for `state: "error"` (shown in the chips/status line only). */
  error?: string;
}

export interface OcrLineEvidence {
  /** The line's visible words, single-spaced (C4 `ocr.ts`). */
  text: string;
  /** `Date.now()` when this line was last reported. */
  at: number;
  /** Per-line confidence (0..1). Kept for the chips/status, never used as a rank weight. */
  confidence: number;
}

/** One image vector with its frame's capture time (RANK.md §2.2 window, C4 `FrameEmbedResult`). */
export interface ImageEvidence {
  vector: readonly number[];
  capturedAt: number;
}

export interface PoolLimits {
  barcodeTtlMs: number;
  ocrLineTtlMs: number;
  imageWindowMs: number;
  maxImageVectors: number;
  maxTextQueries: number;
}

export const DEFAULT_POOL_LIMITS: PoolLimits = {
  barcodeTtlMs: BARCODE_TTL_MS,
  ocrLineTtlMs: OCR_LINE_TTL_MS,
  imageWindowMs: IMAGE_WINDOW_MS,
  maxImageVectors: MAX_IMAGE_VECTORS,
  maxTextQueries: MAX_TEXT_QUERIES,
};

export interface QueryPool {
  /** Live barcode (newest within its TTL), or null. Its `text` may still be pending/null. */
  barcode: BarcodeEvidence | null;
  /** Raw (unprefixed) text queries in slot order: barcode text first, then OCR lines. */
  texts: string[];
  /** Newest-first image vectors inside the 2000 ms window (at most 4), paired with capture time. */
  images: ImageEvidence[];
  /** OCR lines that were live but did not fit the 16-query pool (should stay 0 with barcode-first). */
  droppedOcrLines: number;
  /** Live OCR line count before the cap (for the chips). */
  liveOcrLines: number;
  /** Whether the barcode text (OFF query) got slot 0. */
  barcodeInPool: boolean;
}

/** Newest barcode within its TTL. Its OFF text is used only when it resolved with a name. */
export function liveBarcode(
  barcodes: readonly BarcodeEvidence[],
  now: number,
  ttlMs = BARCODE_TTL_MS,
): BarcodeEvidence | null {
  let best: BarcodeEvidence | null = null;
  for (const entry of barcodes) {
    if (now - entry.at > ttlMs) continue;
    if (best === null || entry.at > best.at) best = entry;
  }
  return best;
}

/**
 * Live OCR lines in detection order, one per distinct text, refreshed `at` on repeats.
 * `evidence` is expected in first-seen order (the controller appends, never reorders).
 */
export function liveOcrLines(
  lines: readonly OcrLineEvidence[],
  now: number,
  ttlMs = OCR_LINE_TTL_MS,
): OcrLineEvidence[] {
  const byText = new Map<string, OcrLineEvidence>();
  for (const line of lines) {
    if (now - line.at > ttlMs) continue;
    const previous = byText.get(line.text);
    if (previous === undefined || line.at >= previous.at) byText.set(line.text, line);
  }
  // `Map` preserves insertion order, which is detection order; a repeat updates in place.
  return [...byText.values()];
}

/** The 4 newest vectors from the last 2000 ms, newest first. */
export function imageWindow(
  images: readonly ImageEvidence[],
  now: number,
  windowMs = IMAGE_WINDOW_MS,
  maxVectors = MAX_IMAGE_VECTORS,
): ImageEvidence[] {
  return images
    .filter((image) => now - image.capturedAt <= windowMs)
    .slice()
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, maxVectors);
}

/**
 * Assemble one tick's query pool. Pure: the controller owns the evidence arrays, this only decides
 * which entries are live and in which order they are handed to the ranker.
 */
export function assembleQueryPool(
  evidence: {
    barcodes: readonly BarcodeEvidence[];
    ocrLines: readonly OcrLineEvidence[];
    images: readonly ImageEvidence[];
  },
  now: number,
  limits: PoolLimits = DEFAULT_POOL_LIMITS,
): QueryPool {
  const barcode = liveBarcode(evidence.barcodes, now, limits.barcodeTtlMs);
  const barcodeText =
    barcode !== null && barcode.text !== null && barcode.text.trim() !== ""
      ? barcode.text.trim()
      : null;

  const ocr = liveOcrLines(evidence.ocrLines, now, limits.ocrLineTtlMs);
  // Barcode-first slot reservation: the barcode must never be the entry dropped by the 16 cap.
  const ocrSlots = Math.max(
    0,
    limits.maxTextQueries - (barcodeText === null ? 0 : 1),
  );
  const keptOcr = ocr.slice(0, ocrSlots);

  const texts = barcodeText === null ? keptOcr.map((line) => line.text) : [barcodeText, ...keptOcr.map((line) => line.text)];

  return {
    barcode,
    texts,
    images: imageWindow(evidence.images, now, limits.imageWindowMs, limits.maxImageVectors),
    droppedOcrLines: Math.max(0, ocr.length - keptOcr.length),
    liveOcrLines: ocr.length,
    barcodeInPool: barcodeText !== null,
  };
}

/** Barcode signals are evidence only once they are new: the controller calls this per signal. */
export function isBarcodeSignal(signal: ScanSignal): boolean {
  return signal.source === "barcode" && signal.text.trim() !== "";
}

/** OCR signals carry one line each (C4 `ocr.ts`); blank lines never reach the pool. */
export function isOcrSignal(signal: ScanSignal): boolean {
  return signal.source === "ocr" && signal.text.trim() !== "";
}
