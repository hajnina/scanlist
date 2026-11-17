/**
 * Card A4-sync — OCR results → **one query per OCR line** (shared/spec/RANK.md §2.2).
 *
 * The pre-sync code joined every line of a frame into one string and averaged confidence across
 * lines; these tests pin the spec shape instead: N lines → N signals, detection order, per-line
 * confidence, 16-line cap, no cross-line average.
 */
import {
  createOcrLineDeduper,
  DEFAULT_OCR_LINE_REPEAT_MS,
  extractOcrLines,
  lineConfidence,
  MAX_OCR_LINES_PER_TICK,
  NEUTRAL_OCR_CONFIDENCE,
  normalizeOcrText,
  ocrLineSignals,
} from '../ocr';

describe('normalizeOcrText', () => {
  test('collapses whitespace within a line and trims', () => {
    expect(normalizeOcrText('  Vollmilch\n\t1 l  ')).toBe('Vollmilch 1 l');
    expect(normalizeOcrText('Bio   Hafer   Drink')).toBe('Bio Hafer Drink');
    expect(normalizeOcrText('   ')).toBe('');
  });
});

describe('lineConfidence', () => {
  test("uses the line's own confidence when present", () => {
    expect(lineConfidence({text: 'a', confidence: 0.87})).toBe(0.87);
  });

  test('falls back to the mean of that line’s element confidences', () => {
    expect(
      lineConfidence({
        text: 'a',
        confidence: null,
        elements: [{confidence: 0.8}, {confidence: 0.6}],
      }),
    ).toBe(0.7);
  });

  test('clamps out-of-range values and rounds to 3 decimals', () => {
    expect(lineConfidence({text: 'a', confidence: 4})).toBe(1);
    expect(lineConfidence({text: 'a', confidence: -1})).toBe(0);
    expect(lineConfidence({text: 'a', confidence: 1 / 3})).toBe(0.333);
    expect(
      lineConfidence({
        text: 'a',
        elements: [{confidence: 5}, {confidence: -5}],
      }),
    ).toBe(0.5);
  });

  test('neutral when the platform reports nothing (iOS)', () => {
    expect(lineConfidence({text: 'Milk'})).toBe(NEUTRAL_OCR_CONFIDENCE);
    expect(
      lineConfidence({text: 'Milk', confidence: null, elements: [{}]}),
    ).toBe(NEUTRAL_OCR_CONFIDENCE);
  });
});

describe('extractOcrLines', () => {
  test('returns one entry per line in detection order, across blocks', () => {
    const lines = extractOcrLines({
      blocks: [
        {
          lines: [
            {text: 'Bio Hafer Drink', confidence: 0.9},
            {text: ' 1 l  ', confidence: 0.7},
          ],
        },
        {lines: [{text: 'Alnatura', confidence: 0.8}]},
      ],
    });

    expect(lines).toEqual([
      {text: 'Bio Hafer Drink', confidence: 0.9},
      {text: '1 l', confidence: 0.7},
      {text: 'Alnatura', confidence: 0.8},
    ]);
  });

  test('never averages confidence across lines', () => {
    const lines = extractOcrLines({
      blocks: [
        {
          lines: [
            {text: 'Milk', confidence: 0.9},
            {text: '1 l', confidence: 0.7},
          ],
        },
      ],
    });

    expect(lines.map(line => line.confidence)).toEqual([0.9, 0.7]);
  });

  test('drops blank and too-short lines (min-length filtering is per line)', () => {
    const lines = extractOcrLines({
      blocks: [
        {
          lines: [
            {text: 'Vollmilch'},
            {text: '  '},
            {text: 'l'},
            {text: '\u00a0'},
          ],
        },
      ],
    });

    expect(lines.map(line => line.text)).toEqual(['Vollmilch']);
    expect(extractOcrLines({blocks: [{lines: [{text: 'l'}]}]}, {minChars: 1}))
      .toEqual([{text: 'l', confidence: NEUTRAL_OCR_CONFIDENCE}]);
  });

  test('keeps the first occurrence of a repeated line (case-insensitive) in order', () => {
    const lines = extractOcrLines({
      blocks: [
        {lines: [{text: 'Bio'}, {text: 'bio'}, {text: 'Hafermilch'}]},
      ],
    });

    expect(lines.map(line => line.text)).toEqual(['Bio', 'Hafermilch']);
  });

  test('caps at 16 lines in detection order by default', () => {
    const many = Array.from({length: 20}, (_, index) => ({
      text: `line ${index + 1}`,
    }));

    const lines = extractOcrLines({blocks: [{lines: many}]});

    expect(MAX_OCR_LINES_PER_TICK).toBe(16);
    expect(lines).toHaveLength(16);
    expect(lines[0].text).toBe('line 1');
    expect(lines[15].text).toBe('line 16');
  });

  test('maxLines honours a stricter cap', () => {
    const lines = extractOcrLines(
      {blocks: [{lines: [{text: 'aaa'}, {text: 'bbb'}, {text: 'ccc'}]}]},
      {maxLines: 2},
    );
    expect(lines.map(line => line.text)).toEqual(['aaa', 'bbb']);
  });

  test('falls back to result.text split on line breaks', () => {
    expect(
      extractOcrLines({text: 'Hafer  drink\n1 l'}).map(line => line.text),
    ).toEqual(['Hafer drink', '1 l']);
  });

  test('empty results produce no lines', () => {
    expect(extractOcrLines({})).toEqual([]);
    expect(extractOcrLines({text: '   '})).toEqual([]);
    expect(extractOcrLines({blocks: [{lines: []}]})).toEqual([]);
  });
});

describe('createOcrLineDeduper', () => {
  test('suppresses one line inside the repeat window and re-fires after it', () => {
    let now = 0;
    const deduper = createOcrLineDeduper(DEFAULT_OCR_LINE_REPEAT_MS, {
      now: () => now,
    });

    expect(deduper.accept('Vollmilch')).toBe(true);
    now = 800;
    expect(deduper.accept('Vollmilch')).toBe(false);
    now = 3999;
    expect(deduper.accept('Vollmilch')).toBe(false);
    now = 4000;
    expect(deduper.accept('Vollmilch')).toBe(true);
  });

  test('is per line: a new line fires while another is suppressed', () => {
    let now = 0;
    const deduper = createOcrLineDeduper(4000, {now: () => now});

    expect(deduper.accept('Milk')).toBe(true);
    now = 100;
    expect(deduper.accept('Milk')).toBe(false);
    expect(deduper.accept('1 l')).toBe(true);
  });

  test('keys are case-insensitive, expiry does not grow the map', () => {
    let now = 0;
    const deduper = createOcrLineDeduper(1000, {now: () => now});

    expect(deduper.accept('Bio')).toBe(true);
    now = 500;
    expect(deduper.accept('BIO')).toBe(false);
    now = 1000;
    expect(deduper.accept('bio')).toBe(true);
    deduper.reset();
    expect(deduper.accept('bio')).toBe(true);
  });

  test('rejects invalid repeat windows', () => {
    expect(() => createOcrLineDeduper(-1)).toThrow(/>= 0/);
    expect(() => createOcrLineDeduper(Number.NaN)).toThrow(/finite/);
  });
});

describe('ocrLineSignals', () => {
  test('emits one ScanSignal per line, in detection order, with that line’s confidence', () => {
    const signals = ocrLineSignals({
      text: 'Milk\n1 l',
      blocks: [
        {
          lines: [
            {text: 'Vollmilch', confidence: 0.9},
            {text: '1 l', confidence: 0.7},
          ],
        },
      ],
    });

    expect(signals).toEqual([
      {source: 'ocr', text: 'Vollmilch', confidence: 0.9},
      {source: 'ocr', text: '1 l', confidence: 0.7},
    ]);
  });

  test('caps a noisy frame at 16 signals', () => {
    const lines = Array.from({length: 25}, (_, index) => ({
      text: `label ${index + 1}`,
    }));

    const signals = ocrLineSignals({blocks: [{lines}]});

    expect(signals).toHaveLength(16);
    expect(signals[15].text).toBe('label 16');
  });

  test('suppresses repeated lines across ticks within the repeat window', () => {
    let now = 0;
    const clock = {now: () => now};
    const deduper = createOcrLineDeduper(4000, clock);
    const result = {
      blocks: [{lines: [{text: 'Vollmilch'}, {text: '1 l'}]}],
    };

    expect(ocrLineSignals(result, {deduper, clock})).toHaveLength(2);

    now = 800;
    expect(ocrLineSignals(result, {deduper, clock})).toHaveLength(0);

    // A changed label line fires on its own even though the stable part is suppressed.
    now = 1600;
    const changed = {
      blocks: [{lines: [{text: 'Vollmilch'}, {text: '2 l'}]}],
    };
    expect(
      ocrLineSignals(changed, {deduper, clock}).map(signal => signal.text),
    ).toEqual(['2 l']);

    now = 4000;
    expect(ocrLineSignals(result, {deduper, clock})).toHaveLength(2);
  });

  test('one-shot calls use their own deduper (repeatMs option)', () => {
    let now = 0;
    const clock = {now: () => now};
    const result = {blocks: [{lines: [{text: 'Milch'}]}]};

    expect(ocrLineSignals(result, {repeatMs: 0, clock})).toHaveLength(1);
    expect(ocrLineSignals(result, {repeatMs: 0, clock})).toHaveLength(1);
  });

  test('empty/blank results emit nothing', () => {
    expect(ocrLineSignals({})).toEqual([]);
    expect(ocrLineSignals({text: ' '})).toEqual([]);
  });
});
