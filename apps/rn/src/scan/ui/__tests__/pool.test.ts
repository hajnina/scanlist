/**
 * Card A5 — the signal pool and the pool-order fix.
 *
 * These tests pin the one rule that is easy to regress: RANK.md §2.2 takes at most 16 text query
 * vectors per tick and the barcode is never the one dropped, even when it arrives after a full
 * batch of OCR lines. Everything else here is the sticky-barcode window and the image window from
 * the same section.
 */
import {MAX_TEXT_QUERIES} from '@scanlist/ts-core';
import {
  DEFAULT_BARCODE_HOLD_MS,
  DEFAULT_IMAGE_WINDOW_MS,
  DEFAULT_MAX_IMAGE_QUERIES,
  SignalPool,
  buildTextQueries,
  type ScanPoolOptions,
} from '../pool';

const barcode = (text: string, confidence = 1) =>
  ({source: 'barcode', text, confidence}) as const;
const ocr = (text: string, confidence = 0.8) =>
  ({source: 'ocr', text, confidence}) as const;
const image = (text = '') => ({source: 'image', text, confidence: 0.5}) as const;

function pool(options: ScanPoolOptions = {}) {
  return new SignalPool(options);
}

// --- buildTextQueries (RANK.md §2.2 pool order) ---------------------------------------------

test('the barcode is first, then OCR lines in detection order', () => {
  expect(
    buildTextQueries('Nutella', ['milk', 'bread', 'eggs']),
  ).toEqual(['Nutella', 'milk', 'bread', 'eggs']);
});

test('a barcode that arrives after 16 OCR lines is still query #1 and OCR keeps 15', () => {
  const lines = Array.from({length: 16}, (_value, index) => `line ${index}`);
  const queries = buildTextQueries('Nutella', lines);
  expect(queries).toHaveLength(MAX_TEXT_QUERIES);
  expect(queries[0]).toBe('Nutella');
  expect(queries.slice(1)).toEqual(lines.slice(0, 15));
  // The sixteenth OCR line is the one dropped, never the barcode.
  expect(queries).not.toContain('line 15');
});

test('without a barcode the pool is 16 OCR lines', () => {
  const lines = Array.from({length: 20}, (_value, index) => `line ${index}`);
  expect(buildTextQueries(null, lines)).toHaveLength(16);
  expect(buildTextQueries(undefined, lines)[15]).toBe('line 15');
  expect(buildTextQueries('', lines)[0]).toBe('line 0');
});

test('deduplicates case-insensitively, trims, and skips empty entries', () => {
  expect(
    buildTextQueries('  Nutella ', [' nutella ', '', '   ', 'Milk', 'milk', 'Bread']),
  ).toEqual(['Nutella', 'Milk', 'Bread']);
});

test('respects a smaller explicit cap for tests/debug builds', () => {
  expect(buildTextQueries('a', ['b', 'c', 'd'], 2)).toEqual(['a', 'b']);
});

// --- SignalPool: barcode stickiness -----------------------------------------------------------

test('a fresh barcode is held for the sticky window, then expires exactly at the boundary', () => {
  const poolAt = pool();
  poolAt.pushSignal(barcode('3017620422003'), 1_000);
  expect(poolAt.freshBarcode(1_001)).toEqual({
    digits: '3017620422003',
    at: 1_000,
  });
  expect(
    poolAt.freshBarcode(1_000 + DEFAULT_BARCODE_HOLD_MS - 1),
  ).not.toBeNull();
  expect(poolAt.freshBarcode(1_000 + DEFAULT_BARCODE_HOLD_MS)).toBeNull();
});

test('the same barcode re-emitted refreshes the hold; a new code replaces it immediately', () => {
  const poolAt = pool();
  poolAt.pushSignal(barcode('3017620422003'), 1_000);
  poolAt.pushSignal(barcode('3017620422003'), 50_000);
  expect(poolAt.freshBarcode(50_000 + DEFAULT_BARCODE_HOLD_MS - 1)).not.toBeNull();
  poolAt.pushSignal(barcode('3245390098214'), 51_000);
  expect(poolAt.freshBarcode(51_000)?.digits).toBe('3245390098214');
});

test('one committed tick ends sticky mode and clears the pending OCR batch', () => {
  const poolAt = pool();
  poolAt.pushSignal(barcode('3017620422003'), 1_000);
  poolAt.pushSignal(ocr('milk'), 1_000);
  expect(poolAt.textQueries('Nutella', 1_100)).toEqual(['Nutella', 'milk']);
  poolAt.markCommitted();
  expect(poolAt.freshBarcode(1_100)).toBeNull();
  expect(poolAt.textQueries('Nutella', 1_100)).toEqual([]);
  expect(poolAt.takeOCR()).toEqual([]);
  // A later emission starts a new scan.
  poolAt.pushSignal(barcode('3017620422003'), 2_000);
  expect(poolAt.freshBarcode(2_000)).not.toBeNull();
});

test('barcode digits alone are never a text query: only the resolved name is', () => {
  const poolAt = pool();
  poolAt.pushSignal(barcode('3017620422003'), 1_000);
  expect(poolAt.textQueries(null, 1_000)).toEqual([]);
  expect(poolAt.textQueries('Nutella', 1_000)).toEqual(['Nutella']);
});

// --- SignalPool: OCR batches -----------------------------------------------------------------

test('takeOCR hands over the batch once and starts a new batch', () => {
  const poolAt = pool();
  poolAt.pushSignal(ocr('one'), 1);
  poolAt.pushSignal(ocr('two'), 2);
  expect(poolAt.takeOCR().map(entry => entry.text)).toEqual(['one', 'two']);
  expect(poolAt.takeOCR()).toEqual([]);
  poolAt.pushSignal(ocr('three'), 3);
  expect(poolAt.takeOCR().map(entry => entry.text)).toEqual(['three']);
});

test('OCR lines landing between ticks are deduplicated case-insensitively', () => {
  const poolAt = pool();
  poolAt.pushSignal(ocr('Milk'), 1);
  poolAt.pushSignal(ocr(' milk '), 2);
  expect(poolAt.takeOCR().map(entry => entry.text)).toEqual(['Milk']);
});

test('blank OCR lines are ignored and the pending batch is bounded', () => {
  const poolAt = pool({maxPendingOcr: 3});
  poolAt.pushSignal(ocr('   '), 1);
  for (let index = 0; index < 10; index += 1) {
    poolAt.pushSignal(ocr(`line ${index}`), index + 2);
  }
  expect(poolAt.takeOCR()).toHaveLength(3);
});

test('snapshot does not consume the pending OCR batch', () => {
  const poolAt = pool();
  poolAt.pushSignal(ocr('milk'), 5);
  expect(poolAt.snapshot(6).ocr.map(entry => entry.text)).toEqual(['milk']);
  expect(poolAt.snapshot(6).ocr.map(entry => entry.text)).toEqual(['milk']);
  expect(poolAt.takeOCR()).toHaveLength(1);
});

// --- SignalPool: image window (RANK.md §2.2) -------------------------------------------------

test('only image vectors from the last 2000 ms survive', () => {
  const poolAt = pool();
  poolAt.pushImageVector([1], 1_000);
  poolAt.pushImageVector([2], 1_500);
  expect(poolAt.imageVectors(2_900)).toEqual([[1], [2]]);
  // 1000 ms is now exactly at the cutoff: kept; at 1001 it falls out.
  expect(poolAt.imageVectors(3_000)).toEqual([[1], [2]]);
  expect(poolAt.imageVectors(1_500 + DEFAULT_IMAGE_WINDOW_MS)).toEqual([[2]]);
  expect(poolAt.imageVectors(3_001)).toEqual([[2]]);
  expect(poolAt.imageVectors(3_000 + DEFAULT_IMAGE_WINDOW_MS)).toEqual([]);
});

test('at most the 4 newest image vectors participate', () => {
  const poolAt = pool();
  for (let index = 0; index < 7; index += 1) {
    poolAt.pushImageVector([index], 1_000 + index);
  }
  expect(poolAt.imageVectors(1_010)).toEqual([[3], [4], [5], [6]]);
  expect(poolAt.imageVectors(1_010)).toHaveLength(DEFAULT_MAX_IMAGE_QUERIES);
});

test('an image signal alone only marks the chip; the vector comes from pushImageVector', () => {
  const poolAt = pool();
  poolAt.pushSignal(image(), 1_000);
  expect(poolAt.imageVectors(1_000)).toEqual([]);
  expect(poolAt.sourceActivity().image).toBe(1_000);
});

// --- chips + reset ---------------------------------------------------------------------------

test('sourceActivity reports when each source last fired', () => {
  const poolAt = pool();
  expect(poolAt.sourceActivity()).toEqual({
    barcode: Number.NEGATIVE_INFINITY,
    ocr: Number.NEGATIVE_INFINITY,
    image: Number.NEGATIVE_INFINITY,
  });
  poolAt.pushSignal(barcode('3017620422003'), 10);
  poolAt.pushSignal(ocr('milk'), 20);
  poolAt.pushSignal(image(), 30);
  expect(poolAt.sourceActivity()).toEqual({barcode: 10, ocr: 20, image: 30});
});

test('reset drops barcode, OCR, images, commit state and chip timestamps', () => {
  const poolAt = pool();
  poolAt.pushSignal(barcode('3017620422003'), 10);
  poolAt.pushSignal(ocr('milk'), 10);
  poolAt.pushImageVector([1], 10);
  poolAt.markCommitted();
  poolAt.reset();
  expect(poolAt.freshBarcode(10)).toBeNull();
  expect(poolAt.takeOCR()).toEqual([]);
  expect(poolAt.imageVectors(10)).toEqual([]);
  expect(poolAt.sourceActivity().barcode).toBe(Number.NEGATIVE_INFINITY);
  poolAt.pushSignal(barcode('3017620422003'), 11);
  expect(poolAt.freshBarcode(11)).not.toBeNull();
});
