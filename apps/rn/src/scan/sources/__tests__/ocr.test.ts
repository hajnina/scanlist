/**
 * Card A4 — OCR result → query text/confidence.
 */
import {buildOcrQuery, normalizeOcrText, ocrSignal} from '../ocr';

describe('normalizeOcrText', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeOcrText('  Vollmilch\n\t1 l  ')).toBe('Vollmilch 1 l');
    expect(normalizeOcrText('   ')).toBe('');
  });
});

describe('buildOcrQuery', () => {
  test('joins lines in reading order and averages confidences', () => {
    const query = buildOcrQuery({
      text: 'Milk\n1 l',
      blocks: [
        {
          lines: [
            {text: 'Milk', confidence: 0.9},
            {text: '1 l', confidence: 0.7},
          ],
        },
      ],
    });

    expect(query).toEqual({text: 'Milk 1 l', confidence: 0.8});
  });

  test('drops duplicate and blank lines', () => {
    const query = buildOcrQuery({
      blocks: [
        {lines: [{text: 'Bio'}, {text: 'bio'}, {text: '  '}]},
        {lines: [{text: 'Hafermilch'}]},
      ],
    });

    expect(query?.text).toBe('Bio Hafermilch');
  });

  test('falls back to result.text when there are no blocks', () => {
    expect(buildOcrQuery({text: 'Hafer  drink'})?.text).toBe('Hafer drink');
  });

  test('neutral confidence when the platform reports none (iOS)', () => {
    expect(buildOcrQuery({blocks: [{lines: [{text: 'Milch', confidence: null}]}]}))
      .toEqual({text: 'Milch', confidence: 0.6});
  });

  test('clamps out-of-range confidences', () => {
    expect(
      buildOcrQuery({
        blocks: [{lines: [{text: 'abc', confidence: 4}, {text: 'def', confidence: -1}]}],
      })?.confidence,
    ).toBe(0.5);
  });

  test('returns undefined for empty or too-short text', () => {
    expect(buildOcrQuery({})).toBeUndefined();
    expect(buildOcrQuery({text: '   '})).toBeUndefined();
    expect(buildOcrQuery({text: 'l'})).toBeUndefined();
    expect(buildOcrQuery({text: 'l'}, 1)?.text).toBe('l');
  });

  test('rounds confidence to 3 decimals', () => {
    const query = buildOcrQuery({
      blocks: [{lines: [{text: 'abc', confidence: 1 / 3}]}],
    });
    expect(query?.confidence).toBe(0.333);
  });
});

describe('ocrSignal', () => {
  test('shapes the A1 ScanSignal', () => {
    expect(ocrSignal({text: 'Vollmilch 1 l'})).toEqual({
      source: 'ocr',
      text: 'Vollmilch 1 l',
      confidence: 0.6,
    });
  });

  test('returns undefined when there is nothing useful', () => {
    expect(ocrSignal({text: ' '})).toBeUndefined();
  });
});
