/**
 * Card C4, born-converged with RANK.md §2.2: **one text query per OCR line**.
 *
 * Pins the semantics the other two tracks paid a sync round for:
 *  - extraction order (blocks → paragraphs → lines) with whitespace collapsed;
 *  - per-line confidence chain (line value → mean of THAT line's elements → 0.6), never a
 *    cross-line average;
 *  - ≤ 16 lines per tick, cap applied AFTER filtering/dedupe — the explicit mutant test below
 *    fails if the cap is applied to raw lines;
 *  - the case-insensitive repeat window across ticks.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OCR_LINE_REPEAT_MS,
  DEFAULT_OCR_MIN_CHARS,
  MAX_OCR_LINES_PER_TICK,
  NEUTRAL_OCR_CONFIDENCE,
  createOcrLineDeduper,
  extractOcrLines,
  lineConfidence,
  normalizeOcrText,
  ocrLineSignals,
  type OcrResultLike,
} from '../ocr';

function page(lines: Array<string | { text: string; confidence?: number; elements?: Array<{ confidence?: number }> }>): OcrResultLike {
  return {
    blocks: [
      {
        lines: lines.map((line) => (typeof line === 'string' ? { text: line } : line)),
      },
    ],
  };
}

describe('OCR constants (documented web picks)', () => {
  it('matches RANK.md §2.2 and the other tracks', () => {
    expect(MAX_OCR_LINES_PER_TICK).toBe(16);
    expect(DEFAULT_OCR_MIN_CHARS).toBe(3);
    expect(NEUTRAL_OCR_CONFIDENCE).toBe(0.6);
    expect(DEFAULT_OCR_LINE_REPEAT_MS).toBe(2000);
  });
});

describe('extractOcrLines', () => {
  it('keeps detection order and normalises each line to single spaces', () => {
    const result: OcrResultLike = {
      blocks: [
        { lines: [{ text: '  Oat   milk\n' }, { text: '1 l' }] },
        { lines: [{ text: 'Dairy > Fridge' }] },
      ],
    };
    expect(extractOcrLines(result).map((line) => line.text)).toEqual([
      'Oat milk',
      '1 l',
      'Dairy > Fridge',
    ]);
  });

  it('drops blank and too-short lines but keeps real words', () => {
    expect(extractOcrLines(page(['', '   ', 'I', 'ab', 'abc', 'Oat milk'])).map((line) => line.text)).toEqual([
      'abc',
      'Oat milk',
    ]);
  });

  it('keeps only the first occurrence of a repeated line (case-insensitive)', () => {
    expect(extractOcrLines(page(['Oat Milk', 'oat milk', 'OAT MILK', 'Eggs'])).map((line) => line.text)).toEqual([
      'Oat Milk',
      'Eggs',
    ]);
  });

  it('falls back to splitting result.text when the backend reports no blocks', () => {
    expect(extractOcrLines({ text: 'Oat milk\nWhole milk\r\nEggs' }).map((line) => line.text)).toEqual([
      'Oat milk',
      'Whole milk',
      'Eggs',
    ]);
    expect(extractOcrLines({})).toEqual([]);
  });

  it('caps at 16 lines in detection order', () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`);
    const extracted = extractOcrLines(page(lines));
    expect(extracted).toHaveLength(MAX_OCR_LINES_PER_TICK);
    expect(extracted[0]?.text).toBe('line 0');
    expect(extracted[15]?.text).toBe('line 15');
  });

  it('applies the cap AFTER filtering/dedupe, not before (mutant guard)', () => {
    // 16 raw lines that all filter out (blank + one duplicate) followed by real lines.
    const raw = ['', ' ', 'I', 'I', 'ab', ...Array.from({ length: 11 }, () => 'same'), 'Oat milk', 'Eggs'];
    const extracted = extractOcrLines(page(raw));
    // Cap-before-filter would take the first 16 raw entries, filter them to one "same" line, and
    // return 1 line; correct behaviour filters first and then keeps the first 16 survivors.
    expect(extracted.map((line) => line.text)).toEqual(['same', 'Oat milk', 'Eggs']);

    // And a page where the 17th raw line is the only real line: a cap-before-filter mutant returns
    // nothing at all.
    const lateLine = [...Array.from({ length: 16 }, () => '  '), 'Oat milk'];
    expect(extractOcrLines(page(lateLine)).map((line) => line.text)).toEqual(['Oat milk']);
  });

  it('honours custom minChars/maxLines', () => {
    expect(extractOcrLines(page(['ab', 'abc', 'abcd']), { minChars: 2 }).map((line) => line.text)).toEqual([
      'ab',
      'abc',
      'abcd',
    ]);
    expect(extractOcrLines(page(['one', 'two', 'three']), { maxLines: 2 }).map((line) => line.text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('normalises whitespace runs in text', () => {
    expect(normalizeOcrText('  a\n\t b   c ')).toBe('a b c');
  });
});

describe('per-line confidence (never a cross-line average)', () => {
  it('uses the line value when present', () => {
    expect(lineConfidence({ text: 'Oat milk', confidence: 0.83 })).toBe(0.83);
  });

  it('averages only THAT line’s elements when the line has no confidence', () => {
    expect(
      lineConfidence({
        text: 'Oat milk',
        confidence: null,
        elements: [{ confidence: 0.9 }, { confidence: 0.5 }, { confidence: null }],
      }),
    ).toBe(0.7);
  });

  it('falls back to the neutral 0.6 when nothing is reported', () => {
    expect(lineConfidence({ text: 'Oat milk' })).toBe(0.6);
    expect(lineConfidence({ text: 'Oat milk', elements: [] })).toBe(0.6);
  });

  it('clamps and rounds to 3 dp', () => {
    expect(lineConfidence({ text: 'x', confidence: 1.7 })).toBe(1);
    expect(lineConfidence({ text: 'x', confidence: -0.2 })).toBe(0);
    expect(lineConfidence({ text: 'x', confidence: 0.123456 })).toBe(0.123);
  });

  it('keeps each line’s own confidence in a mixed page', () => {
    const lines = extractOcrLines(
      page([
        { text: 'Oat milk', confidence: 0.9 },
        { text: 'Whole milk', elements: [{ confidence: 0.4 }, { confidence: 0.6 }] },
        { text: 'Eggs' },
      ]),
    );
    expect(lines.map((line) => line.confidence)).toEqual([0.9, 0.5, 0.6]);
  });
});

describe('ocrLineSignals (one signal per line, repeat-suppressed)', () => {
  it('emits one A1-shaped signal per line with that line’s confidence and the tick timestamp', () => {
    const signals = ocrLineSignals(
      page([
        { text: 'Oat milk', confidence: 0.8 },
        { text: 'Whole milk', confidence: 0.5 },
      ]),
      { clock: { now: () => 1234 } },
    );
    expect(signals).toEqual([
      { source: 'ocr', text: 'Oat milk', confidence: 0.8, at: 1234 },
      { source: 'ocr', text: 'Whole milk', confidence: 0.5, at: 1234 },
    ]);
  });

  it('suppresses the same line inside the 2 s window and re-emits it after', () => {
    const result = page(['Oat milk', 'Whole milk']);
    let now = 0;
    const clock = { now: () => now };
    // The deduper is what carries the window across ticks; `ocrLineSignals` creates a fresh one per
    // call only for one-shot use (the source shares one, see ocrSource.ts).
    const deduper = createOcrLineDeduper(2000, clock);

    expect(ocrLineSignals(result, { deduper, clock }).map((signal) => signal.text)).toEqual([
      'Oat milk',
      'Whole milk',
    ]);
    now = 1000;
    expect(ocrLineSignals(result, { deduper, clock })).toEqual([]);
    now = 1999;
    expect(ocrLineSignals(result, { deduper, clock })).toEqual([]);
    now = 2000;
    expect(ocrLineSignals(result, { deduper, clock }).map((signal) => signal.text)).toEqual([
      'Oat milk',
      'Whole milk',
    ]);
  });

  it('uses the shared deduper across calls when one is passed', () => {
    const deduper = createOcrLineDeduper(5000);
    const result = page(['Oat milk']);
    expect(ocrLineSignals(result, { deduper, clock: { now: () => 0 } })).toHaveLength(1);
    expect(ocrLineSignals(result, { deduper, clock: { now: () => 4000 } })).toHaveLength(0);
    expect(ocrLineSignals(result, { deduper, clock: { now: () => 5000 } })).toHaveLength(1);
  });

  it('respects a custom repeat window and validates it', () => {
    const result = page(['Oat milk']);
    expect(ocrLineSignals(result, { repeatMs: 0, clock: { now: () => 0 } })).toHaveLength(1);
    expect(ocrLineSignals(result, { repeatMs: 0, clock: { now: () => 0 } })).toHaveLength(1);
    expect(() => createOcrLineDeduper(-1)).toThrow(/repeat/);
  });

  it('emits at most 16 signals for a busy page', () => {
    const signals = ocrLineSignals(
      page(Array.from({ length: 40 }, (_, index) => `line ${index}`)),
      { clock: { now: () => 0 } },
    );
    expect(signals).toHaveLength(16);
    expect(signals.at(-1)?.text).toBe('line 15');
  });
});
