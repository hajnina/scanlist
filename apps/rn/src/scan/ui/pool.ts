/**
 * Signal pool for one scan tick (card A5) — the bridge from A4's `ScanSignal[]` to ts-core's
 * `rank(queries)`, including the **pool-order fix** the B5 card flagged.
 *
 * What arrives (see ../sources/README.md):
 *  - one `barcode` signal per detected GTIN (digits; confidence 1) — debounced 4 s in the source;
 *  - up to 16 `ocr` signals per batch, **one per line**, in detection order;
 *  - one `image` signal per sampled frame (the JPEG vector is pushed separately, via
 *    `pushImageVector`, once the embedder returns).
 *
 * RANK.md §2.2 allows at most **16 text query vectors per tick** (barcode + OCR lines, dropping
 * extra OCR lines in detection order). Without care, 16 OCR lines + 1 barcode = 17 candidates and a
 * barcode arriving last would be dropped by the ranker's `take(16)`. The spec says the barcode is
 * kept, so {@linkcode buildTextQueries} always puts the resolved barcode name **first** and caps
 * OCR at what is left (15 with a barcode present). That is this file's reason to exist.
 *
 * Also here: sticky barcode mode. The barcode source re-emits the same code only every 4 s while it
 * stays in frame, so the pool holds a fresh barcode for `barcodeHoldMs` (60 s by default) — the hero
 * does not dissolve 400 ms after the scan while the shopper is still reading it. One committed tick
 * (`markCommitted`) or the hold expiring ends it (Barcode Buddy's "auto-revert after N min or one
 * tick", per the card's digest note).
 */
import {MAX_TEXT_QUERIES} from '@scanlist/ts-core';
import type {ScanSignal} from '../sources';

/** A fresh barcode keeps its text query this long after its last emission (sticky scan mode). */
export const DEFAULT_BARCODE_HOLD_MS = 60_000;
/** RANK.md §2.2 image window: the 4 most recent image vectors from the last 2000 ms. */
export const DEFAULT_IMAGE_WINDOW_MS = 2_000;
export const DEFAULT_MAX_IMAGE_QUERIES = 4;
/** Safety bound on un-ticked OCR lines (the source already caps a batch at 16). */
export const DEFAULT_MAX_PENDING_OCR = 32;

export interface ScanPoolOptions {
  /** Max text queries per tick. Default {@linkcode MAX_TEXT_QUERIES} (16). */
  maxTextQueries?: number;
  barcodeHoldMs?: number;
  imageWindowMs?: number;
  maxImageQueries?: number;
  maxPendingOcr?: number;
}

export interface BarcodePoolEntry {
  digits: string;
  /** `Date.now()` of the last emission. */
  at: number;
}

export interface OcrPoolEntry {
  text: string;
  confidence: number;
  at: number;
}

export interface ImagePoolEntry {
  vector: readonly number[];
  at: number;
}

export interface PoolSnapshot {
  at: number;
  barcode: BarcodePoolEntry | null;
  ocr: OcrPoolEntry[];
  /** Fresh image vectors, newest last. */
  images: ImagePoolEntry[];
}

/**
 * RANK.md §2.2 pool order: barcode first, then OCR lines in detection order, deduplicated, capped
 * at `max` (16). With a barcode present the OCR side therefore contributes at most 15 queries.
 */
export function buildTextQueries(
  barcodeName: string | null | undefined,
  ocrLines: readonly string[],
  max: number = MAX_TEXT_QUERIES,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const text = (value ?? '').trim();
    if (text === '' || out.length >= max) {
      return;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(text);
  };
  push(barcodeName);
  for (const line of ocrLines) {
    push(line);
  }
  return out;
}

/**
 * Mutable pool owned by the scan screen. Purely synchronous and clock-injected: the screen calls
 * `pushSignal`/`pushImageVector` from the source callbacks, the engine calls `takeOCR`/`snapshot`
 * once per tick.
 */
export class SignalPool {
  private readonly maxTextQueries: number;
  private readonly barcodeHoldMs: number;
  private readonly imageWindowMs: number;
  private readonly maxImageQueries: number;
  private readonly maxPendingOcr: number;

  private barcodeEntry: BarcodePoolEntry | null = null;
  private ocrEntries: OcrPoolEntry[] = [];
  private imageEntries: ImagePoolEntry[] = [];
  /** Whether the barcode has been committed once (sticky mode ends, see `markCommitted`). */
  private barcodeCommitted = false;
  /** Last time each source produced anything — the chips' "lit" state. */
  private readonly lastFiredAt: Record<'barcode' | 'ocr' | 'image', number> = {
    barcode: Number.NEGATIVE_INFINITY,
    ocr: Number.NEGATIVE_INFINITY,
    image: Number.NEGATIVE_INFINITY,
  };

  constructor(options: ScanPoolOptions = {}) {
    this.maxTextQueries = options.maxTextQueries ?? MAX_TEXT_QUERIES;
    this.barcodeHoldMs = options.barcodeHoldMs ?? DEFAULT_BARCODE_HOLD_MS;
    this.imageWindowMs = options.imageWindowMs ?? DEFAULT_IMAGE_WINDOW_MS;
    this.maxImageQueries =
      options.maxImageQueries ?? DEFAULT_MAX_IMAGE_QUERIES;
    this.maxPendingOcr = options.maxPendingOcr ?? DEFAULT_MAX_PENDING_OCR;
  }

  /** Feed one A4 signal. `at` defaults to `Date.now()`. */
  pushSignal(signal: ScanSignal, at: number = Date.now()): void {
    if (signal.source === 'barcode') {
      const digits = signal.text.trim();
      // A new code replaces the previous one immediately; the same code refreshes the hold.
      this.barcodeEntry = {digits, at};
      this.barcodeCommitted = false;
      this.lastFiredAt.barcode = at;
      return;
    }
    if (signal.source === 'ocr') {
      const text = signal.text.trim();
      if (text === '') {
        return;
      }
      this.lastFiredAt.ocr = at;
      if (this.ocrEntries.length >= this.maxPendingOcr) {
        return; // bound memory; the source caps batches far below this
      }
      // Within one batch the source already dedupes; this guard only covers two batches that
      // land between ticks (e.g. a slow embedder).
      if (
        this.ocrEntries.some(entry => entry.text.toLowerCase() === text.toLowerCase())
      ) {
        return;
      }
      this.ocrEntries.push({text, confidence: signal.confidence, at});
      return;
    }
    // Image signals only mark the chip: the vector arrives from `onImage` → pushImageVector.
    this.lastFiredAt.image = at;
  }

  /** Called from the screen's `onImage` once the frame vector is back. */
  pushImageVector(vector: readonly number[], at: number = Date.now()): void {
    this.imageEntries.push({vector, at});
    this.lastFiredAt.image = at;
    this.pruneImages(at);
  }

  private pruneImages(at: number): void {
    const cutoff = at - this.imageWindowMs;
    this.imageEntries = this.imageEntries
      .filter(entry => entry.at >= cutoff)
      .slice(-this.maxImageQueries);
  }

  /**
   * The text queries of this tick, in pool order (barcode first) and capped at 16 — see
   * {@linkcode buildTextQueries}. `barcodeName` is the OFF-derived name (not the digits).
   */
  textQueries(
    barcodeName: string | null | undefined,
    at: number = Date.now(),
  ): string[] {
    const entry = this.freshBarcode(at);
    return buildTextQueries(
      entry === null ? null : barcodeName,
      this.ocrEntries.map(line => line.text),
      this.maxTextQueries,
    );
  }

  /** The barcode still inside its sticky hold, or `null`. */
  freshBarcode(at: number = Date.now()): BarcodePoolEntry | null {
    if (this.barcodeEntry === null || this.barcodeCommitted) {
      return null;
    }
    if (at - this.barcodeEntry.at >= this.barcodeHoldMs) {
      return null;
    }
    return this.barcodeEntry;
  }

  /** Image vectors inside the §2.2 window, oldest first. */
  imageVectors(at: number = Date.now()): number[][] {
    this.pruneImages(at);
    return this.imageEntries.map(entry => [...entry.vector]);
  }

  /** Take the pending OCR batch for this tick (clears it; the next batch replaces it). */
  takeOCR(): OcrPoolEntry[] {
    const lines = this.ocrEntries;
    this.ocrEntries = [];
    return lines;
  }

  /** Everything the engine needs for one tick; does **not** clear the OCR batch. */
  snapshot(at: number = Date.now()): PoolSnapshot {
    this.pruneImages(at);
    return {
      at,
      barcode: this.freshBarcode(at),
      ocr: [...this.ocrEntries],
      images: [...this.imageEntries],
    };
  }

  /** End sticky barcode mode after the hero was committed to the list. */
  markCommitted(): void {
    this.barcodeCommitted = true;
    this.ocrEntries = [];
  }

  /** Chip state: when each source last fired (negative infinity = never). */
  sourceActivity(): Readonly<Record<'barcode' | 'ocr' | 'image', number>> {
    return {...this.lastFiredAt};
  }

  /** Drop everything (scan stopped / list changed). */
  reset(): void {
    this.barcodeEntry = null;
    this.ocrEntries = [];
    this.imageEntries = [];
    this.barcodeCommitted = false;
    this.lastFiredAt.barcode = Number.NEGATIVE_INFINITY;
    this.lastFiredAt.ocr = Number.NEGATIVE_INFINITY;
    this.lastFiredAt.image = Number.NEGATIVE_INFINITY;
  }
}
