/**
 * OCR signal shaping (card A4).
 *
 * ML Kit text recognition returns blocks → lines → elements. The scan pipeline only wants one
 * query string per sampled frame ("visible words") plus a confidence for the OCR chip, so this
 * module flattens lines, drops duplicates/empty strings and averages the per-line confidences
 * (Android reports them; iOS reports `null` → fall back to a neutral 0.6).
 */
import type {ScanSignal} from './types';

export interface OcrLineLike {
  text?: string | null;
  confidence?: number | null;
}

export interface OcrBlockLike {
  lines?: readonly OcrLineLike[] | null;
}

export interface OcrResultLike {
  text?: string | null;
  blocks?: readonly OcrBlockLike[] | null;
}

/** Collapse all whitespace (ML Kit keeps line breaks and padding) into single spaces. */
export function normalizeOcrText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface OcrQuery {
  text: string;
  confidence: number;
}

const NEUTRAL_CONFIDENCE = 0.6;

/**
 * Flatten an ML Kit result into one query string. Returns `undefined` when the frame contains
 * nothing worth ranking on (blank wall, only a barcode, …).
 *
 * `minChars` keeps single glyphs ("I", "l", a stray comma) from firing the OCR chip.
 */
export function buildOcrQuery(
  result: OcrResultLike,
  minChars: number = 3,
): OcrQuery | undefined {
  const lines: string[] = [];
  const confidences: number[] = [];

  for (const block of result.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const text = normalizeOcrText(line.text ?? '');
      if (text.length === 0) {
        continue;
      }
      lines.push(text);
      if (
        typeof line.confidence === 'number' &&
        Number.isFinite(line.confidence)
      ) {
        confidences.push(Math.min(1, Math.max(0, line.confidence)));
      }
    }
  }

  // Some backends only fill `result.text`; fall back to it rather than dropping the frame.
  if (lines.length === 0) {
    const fallback = normalizeOcrText(result.text ?? '');
    if (fallback.length === 0) {
      return undefined;
    }
    lines.push(fallback);
  }

  // Keep reading order but do not repeat the same line twice (logos, reflections).
  const seen = new Set<string>();
  const words = lines.filter(line => {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const text = normalizeOcrText(words.join(' '));
  if (text.length < minChars) {
    return undefined;
  }

  const confidence =
    confidences.length === 0
      ? NEUTRAL_CONFIDENCE
      : confidences.reduce((sum, value) => sum + value, 0) /
        confidences.length;

  return {text, confidence: Math.round(confidence * 1000) / 1000};
}

/** Signal for the OCR source; `undefined` when the text is too short to be useful. */
export function ocrSignal(
  result: OcrResultLike,
  minChars: number = 3,
): ScanSignal | undefined {
  const query = buildOcrQuery(result, minChars);
  if (query === undefined) {
    return undefined;
  }
  return {source: 'ocr', text: query.text, confidence: query.confidence};
}
