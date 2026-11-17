/**
 * OCR signal shaping (card A4, converged to shared/spec/RANK.md §2.2 "Text/OCR source").
 *
 * The spec mandates **one text query per OCR line**:
 *
 *   > each OCR line is its own text query: `queryPrefix + trim(line)`, where the line is the
 *   > visible words in reading order joined by single spaces. […] At most 16 text query vectors
 *   > per tick are used (barcode + OCR lines, dropping extra OCR lines in detection order). All
 *   > supplied vectors participate; the ranker takes the max, never an average.
 *
 * So this module no longer joins blocks/lines into one frame-wide string and no longer averages
 * confidence across different lines. ML Kit already returns lines with their visible words in
 * reading order; each of them becomes its own {@linkcode ScanSignal} with **that line's own**
 * confidence (its `confidence`, else the mean of its element confidences, else a neutral 0.6 —
 * never a cross-line mean).
 *
 * Pool cap: the ranker owns the combined "≤ 16 text vectors per tick" rule (barcode + OCR lines,
 * S8's rank/decideTop). This source caps its own OCR lines at
 * {@linkcode MAX_OCR_LINES_PER_TICK} per batch so it cannot flood the pool; a barcode signal is
 * additional — one frame can carry up to 17 text signals — and the ranker drops the extras in
 * detection order.
 */
import {type Clock, systemClock} from './clock';
import type {ScanSignal} from './types';

export interface OcrElementLike {
  confidence?: number | null;
}

export interface OcrLineLike {
  text?: string | null;
  /** Android fills this; iOS reports `null` (then the element confidences are averaged). */
  confidence?: number | null;
  elements?: readonly OcrElementLike[] | null;
}

export interface OcrBlockLike {
  lines?: readonly OcrLineLike[] | null;
}

export interface OcrResultLike {
  text?: string | null;
  blocks?: readonly OcrBlockLike[] | null;
}

/** RANK.md §2.2 pool cap. Barcode + OCR ≤ 16 text vectors per tick; OCR alone may not exceed it. */
export const MAX_OCR_LINES_PER_TICK = 16;
/** Do not re-emit an identical line within this window (mirrors the barcode debounce). */
export const DEFAULT_OCR_LINE_REPEAT_MS = 4000;
export const DEFAULT_OCR_MIN_CHARS = 3;
/** Used when neither the line nor its elements report a confidence (iOS). */
export const NEUTRAL_OCR_CONFIDENCE = 0.6;

/** Collapse all whitespace (ML Kit keeps line breaks and padding) into single spaces. */
export function normalizeOcrText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** One OCR line as a query: its visible words (single-spaced) and its own confidence. */
export interface OcrLine {
  text: string;
  confidence: number;
}

/**
 * Confidence of a single ML Kit line — never across lines:
 *  1. the line's own `confidence` (Android);
 *  2. else the mean of the line's element confidences;
 *  3. else {@linkcode NEUTRAL_OCR_CONFIDENCE} (iOS reports none).
 */
export function lineConfidence(line: OcrLineLike): number {
  if (typeof line.confidence === 'number' && Number.isFinite(line.confidence)) {
    return round3(clampConfidence(line.confidence));
  }
  const elementConfidences = (line.elements ?? [])
    .map(element => element?.confidence)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    )
    .map(clampConfidence);
  if (elementConfidences.length > 0) {
    return round3(mean(elementConfidences));
  }
  return NEUTRAL_OCR_CONFIDENCE;
}

export interface ExtractOcrLinesOptions {
  /** Ignore lines shorter than this after whitespace normalisation. Default 3. */
  minChars?: number;
  /** Hard cap on emitted lines, in detection order. Default {@linkcode MAX_OCR_LINES_PER_TICK}. */
  maxLines?: number;
  /**
   * Optional cross-tick suppression (the repeat window). Called after blank/too-short and
   * within-batch duplicate filtering, and before the cap counts the line: a suppressed line
   * consumes no cap slot, exactly like the merged Kotlin B4-sync batcher.
   */
  acceptLine?: (text: string) => boolean;
}

/**
 * Flatten an ML Kit result into per-line queries in detection order.
 *
 * Order matches the merged Kotlin B4-sync batcher: normalise → drop blank/too-short → collapse
 * duplicates within the batch → apply the optional cross-tick `acceptLine` predicate → count
 * against `maxLines`. Suppressed lines therefore consume no cap slots and fresh lines further
 * down a held page still get emitted.
 *
 * When the backend only fills `result.text`, it is split on line breaks so the per-line contract
 * still holds.
 */
export function extractOcrLines(
  result: OcrResultLike,
  {
    minChars = DEFAULT_OCR_MIN_CHARS,
    maxLines = MAX_OCR_LINES_PER_TICK,
    acceptLine,
  }: ExtractOcrLinesOptions = {},
): OcrLine[] {
  const raw: OcrLineLike[] = [];
  for (const block of result.blocks ?? []) {
    for (const line of block.lines ?? []) {
      raw.push(line);
    }
  }

  if (raw.length === 0) {
    // Fallback: some backends only provide the concatenated text.
    for (const text of (result.text ?? '').split(/\r?\n/)) {
      raw.push({text});
    }
  }

  const lines: OcrLine[] = [];
  const seen = new Set<string>();
  for (const line of raw) {
    const text = normalizeOcrText(line.text ?? '');
    if (text.length < minChars) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (acceptLine !== undefined && !acceptLine(text)) {
      continue;
    }
    lines.push({text, confidence: lineConfidence(line)});
    if (lines.length >= maxLines) {
      break;
    }
  }

  return lines;
}

export interface OcrLineDeduper {
  readonly repeatMs: number;
  /** True if this line should be emitted now. */
  accept(text: string, at?: number): boolean;
  reset(): void;
}

/**
 * Time-based repeat window, keyed per line (unlike the single-value barcode deduper): pointing at
 * the same shelf re-emits the same words only every `repeatMs`, so an 800 ms OCR tick does not
 * re-rank on identical queries four times in a row.
 */
export function createOcrLineDeduper(
  repeatMs: number = DEFAULT_OCR_LINE_REPEAT_MS,
  clock: Clock = systemClock,
): OcrLineDeduper {
  if (!Number.isFinite(repeatMs) || repeatMs < 0) {
    throw new Error(
      `ocr line repeat must be a finite number >= 0, got ${repeatMs}`,
    );
  }
  /** lowercased text → last emitted timestamp */
  const lastEmittedAt = new Map<string, number>();

  return {
    repeatMs,
    accept(text: string, at: number = clock.now()): boolean {
      const key = text.toLowerCase();
      // Drop expired entries so a long scanning session keeps the map small.
      for (const [entryKey, emittedAt] of lastEmittedAt) {
        if (at - emittedAt >= repeatMs) {
          lastEmittedAt.delete(entryKey);
        }
      }
      if (lastEmittedAt.has(key)) {
        return false;
      }
      lastEmittedAt.set(key, at);
      return true;
    },
    reset(): void {
      lastEmittedAt.clear();
    },
  };
}

export interface OcrLineSignalsOptions extends ExtractOcrLinesOptions {
  /** Repeat window when no shared `deduper` is passed. Default {@linkcode DEFAULT_OCR_LINE_REPEAT_MS}. */
  repeatMs?: number;
  /** Shared across ticks by the source; created on demand for one-shot calls. */
  deduper?: OcrLineDeduper;
  clock?: Clock;
}

/**
 * Turn one ML Kit result into **one ScanSignal per OCR line** (≤ {@linkcode MAX_OCR_LINES_PER_TICK},
 * detection order). Lines emitted within the repeat window are suppressed *before* the cap, so a
 * carried-over page cannot starve fresh lines further down the frame.
 */
export function ocrLineSignals(
  result: OcrResultLike,
  {
    minChars,
    maxLines,
    repeatMs,
    deduper,
    clock = systemClock,
  }: OcrLineSignalsOptions = {},
): ScanSignal[] {
  const dedupe = deduper ?? createOcrLineDeduper(repeatMs, clock);
  const now = clock.now();

  return extractOcrLines(result, {
    minChars,
    maxLines,
    acceptLine: text => dedupe.accept(text, now),
  }).map(line => ({
    source: 'ocr' as const,
    text: line.text,
    confidence: line.confidence,
  }));
}
