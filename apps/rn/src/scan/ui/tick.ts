/**
 * The rank wiring of the magic scan (card A5): A4 `ScanSignal`s → ts-core `rank` → hero.
 *
 * One {@linkcode ScanTickEngine} per open scan screen. It owns
 *
 *  - the signal pool ({@linkcode SignalPool}: barcode sticky, one entry per OCR line, image window),
 *  - the item vector cache (docText → vector, embedded once via the A3 `Embedder`),
 *  - the ranker state (`rank()`'s `state`, threaded between ticks for EMA + hysteresis),
 *
 * and nothing else. There is **no margin/gate logic here** — RANK.md §6.2/§6.3 live in ts-core's
 * `decideTop`, and the hero is exactly `output.topId` (nullable). The UI never derives a hero from
 * `entries[0]`.
 *
 * What one tick does, in order (RANK.md §7 "signals replace the pending query set"):
 *
 *  1. resolve the fresh barcode through OFF (`barcodeName`, also the +0.15 boost input),
 *  2. build the ≤16 text queries with **the barcode first** (pool-order fix, see `pool.ts`),
 *  3. embed the queries (cache per text; the embedder adds the query prefix — RANK.md §2.2),
 *  4. rank with the image-window vectors (newest 4 / 2000 ms) and the persisted state,
 *  5. report `hero` / `no-hero` / `no-signal` so the screen can be honest about the null state.
 *
 * Everything is injectable (clock, embedder, OFF lookup) so the wiring is tested in plain Jest with
 * synthetic signal sequences and no camera, model or network.
 */
import {
  DIMS_ACTIVE,
  MAX_TEXT_QUERIES,
  docText,
  rank,
  unranked,
  type FlattenedItem,
  type RankItem,
  type RankOutput,
  type RankQueries,
  type RankState,
} from '@scanlist/ts-core';
import type {CameraFrame, ScanSignal} from '../sources';
import type {OffLookupSource, OffLookupResult} from './off';
import {
  SignalPool,
  buildTextQueries,
  type PoolSnapshot,
  type ScanPoolOptions,
} from './pool';

/** The slice of A3's `Embedder` the scan engine uses. Prefixes are the embedder's job. */
export interface ScanEmbedder {
  embedDocs(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  embedImage(image: {base64: string}): Promise<number[]>;
  /** Active dims (256 in production); only a fallback until the first vector arrives. */
  readonly dims?: number;
}

/** The slice of the OFF client the engine needs; `OffClient` satisfies it. */
export interface OffTextLookup {
  lookup(barcode: string): Promise<Pick<OffLookupResult, 'text'> & Partial<OffLookupResult>>;
}

/** Barcode text provenance: OFF lookup sources plus the "lookup threw" state. */
export type ScanBarcodeSource = OffLookupSource | 'unresolved';

export type ScanTickReason =
  /** A hero survived the gates: `topId` is set. */
  | 'hero'
  /** Ranked, but the gate/guard closed the hero (image unconfirmed, margin/floor too small). */
  | 'no-hero'
  /** No text/image query at all — unranked, JSON order (RANK.md §8). */
  | 'no-signal'
  /** The list has no unchecked item to rank. */
  | 'no-items'
  /** Item or query embedding failed (typically `E_MODEL_MISSING`); the last output is kept. */
  | 'embed-unavailable';

export interface ScanTick {
  at: number;
  reason: ScanTickReason;
  output: RankOutput;
  /** `output.topId`, repeated for the hero card (never derived from `entries[0]`). */
  heroId: string | null;
  /** The barcode of this tick, if any, with the resolved OFF name. */
  barcode: {
    digits: string;
    text: string | null;
    source: ScanBarcodeSource;
  } | null;
  /** Text queries actually embedded this tick, in pool order (barcode first). */
  textQueries: string[];
  /** Number of image query vectors that participated. */
  imageQueries: number;
  /** OCR lines taken for this tick (what the OCR chip reports). */
  ocrLines: string[];
  error: string | null;
}

export interface ScanTickEngineOptions {
  embedder: ScanEmbedder;
  off: OffTextLookup;
  /** Items in FLATTEN order; `done` items are skipped by the ranker. */
  items?: readonly FlattenedItem[];
  now?: () => number;
  pool?: ScanPoolOptions;
  /** Fallback dims until the first vector arrives. Default 256. */
  dims?: number;
  /** Max text queries per tick. Default {@linkcode MAX_TEXT_QUERIES} (16). */
  maxTextQueries?: number;
}

function emptyOutput(items: readonly FlattenedItem[]): RankOutput {
  return unranked(items);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: unknown}).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Snapshot of what the chips / debug line show, without consuming the pending OCR batch. */
export interface ScanTickSnapshot {
  at: number;
  pool: PoolSnapshot;
  barcodeName: string | null;
  itemCount: number;
  embeddedItems: number;
  dims: number;
  state: RankState | null;
}

export class ScanTickEngine {
  private readonly embedder: ScanEmbedder;
  private readonly off: OffTextLookup;
  private readonly now: () => number;
  private readonly pool: SignalPool;
  private readonly maxTextQueries: number;

  private items: readonly FlattenedItem[] = [];
  /** RANK.md §2.1 item vector cache: docText → vector (prefix/model/dims fixed this session). */
  private readonly itemVectors = new Map<string, number[]>();
  /** Query text → vector; the same OCR line should not be embedded twice per session. */
  private readonly queryVectors = new Map<string, number[]>();
  private dims: number;
  private state: RankState | null = null;
  private lastOutput: RankOutput | null = null;
  private lastBarcode: {
    digits: string;
    text: string | null;
    source: ScanBarcodeSource;
  } | null = null;
  private lastError: string | null = null;
  /** Items (id + docText) signature: a content change clears the EMA/hysteresis state. */
  private itemsSignature = '';
  private pendingTick: Promise<ScanTick> | null = null;

  constructor(options: ScanTickEngineOptions) {
    this.embedder = options.embedder;
    this.off = options.off;
    this.now = options.now ?? (() => Date.now());
    this.maxTextQueries = options.maxTextQueries ?? MAX_TEXT_QUERIES;
    this.pool = new SignalPool({
      ...options.pool,
      maxTextQueries: this.maxTextQueries,
    });
    this.dims =
      options.dims ??
      (typeof options.embedder.dims === 'number' && options.embedder.dims > 0
        ? options.embedder.dims
        : DIMS_ACTIVE);
    if (options.items !== undefined) {
      this.setItems(options.items);
    }
  }

  /**
   * Replace the item list. Identical content (same ids and doc texts) keeps the ranker state so a
   * `done` flip only drops that item's EMA entry inside `rank`; any real content change clears it
   * (RANK.md §7 "the list content changes").
   */
  setItems(items: readonly FlattenedItem[]): void {
    const signature = items.map(item => `${item.id}\u0000${docText(item)}`).join('\u0001');
    if (signature !== this.itemsSignature) {
      this.itemsSignature = signature;
      this.state = null;
      this.lastOutput = null;
    }
    this.items = items;
  }

  getItems(): readonly FlattenedItem[] {
    return this.items;
  }

  /** Feed one source signal. No I/O, no timer — the screen schedules the tick. */
  pushSignal(signal: ScanSignal, at: number = this.now()): void {
    this.pool.pushSignal(signal, at);
  }

  /** Feed an image vector directly (tests, or a backend that embeds frames itself). */
  pushImageVector(vector: readonly number[], at: number = this.now()): void {
    this.pool.pushImageVector(vector, at);
  }

  /** `onImage` for the image source: embed the JPEG (no prefix, RANK.md §2.2) into the pool. */
  async pushImageFrame(frame: CameraFrame): Promise<void> {
    try {
      const vector = await this.embedder.embedImage({base64: frame.jpegBase64});
      if (!this.hasValidVector(vector)) {
        throw new Error(
          `image vector has ${vector.length} dims, expected ${this.dims}`,
        );
      }
      this.pool.pushImageVector(vector, frame.capturedAt);
    } catch (error) {
      // One failed frame must not stop the other chips (A4 failure isolation).
      this.lastError = `image embed: ${errorMessage(error)}`;
    }
  }

  /** End sticky barcode mode: called when the hero is committed to the list. */
  markCommitted(): void {
    this.pool.markCommitted();
  }

  /** Scan stopped: both sources and the ranker state go back to unranked (RANK.md §7). */
  reset(): void {
    this.pool.reset();
    this.state = null;
    this.lastOutput = null;
    this.lastBarcode = null;
    this.lastError = null;
    this.queryVectors.clear();
  }

  snapshot(): ScanTickSnapshot {
    const at = this.now();
    return {
      at,
      pool: this.pool.snapshot(at),
      barcodeName: this.lastBarcode?.text ?? null,
      itemCount: this.items.length,
      embeddedItems: this.itemVectors.size,
      dims: this.dims,
      state: this.state,
    };
  }

  sourceActivity(): Readonly<Record<'barcode' | 'ocr' | 'image', number>> {
    return this.pool.sourceActivity();
  }

  /**
   * Run one evaluation tick. Single-flight: a second call while a tick is in progress returns the
   * same promise (the screen's 400 ms timer can otherwise overlap a slow OFF/embed call).
   */
  tick(): Promise<ScanTick> {
    if (this.pendingTick !== null) {
      return this.pendingTick;
    }
    const running = this.runTick().finally(() => {
      this.pendingTick = null;
    });
    this.pendingTick = running;
    return running;
  }

  private async runTick(): Promise<ScanTick> {
    const at = this.now();
    const snapshot = this.pool.snapshot(at);
    const ocr = this.pool.takeOCR();
    const ocrTexts = ocr.map(line => line.text);

    // 1. Barcode → OFF name (§2.2: the name is the query; the digits never are).
    let barcode: ScanTick['barcode'] = null;
    let barcodeName: string | null = null;
    if (snapshot.barcode !== null) {
      try {
        const resolved = await this.off.lookup(snapshot.barcode.digits);
        barcodeName = resolved.text;
        barcode = {
          digits: snapshot.barcode.digits,
          text: resolved.text,
          source: resolved.source ?? 'unresolved',
        };
        this.lastBarcode = {
          digits: snapshot.barcode.digits,
          text: resolved.text,
          source: resolved.source ?? 'unresolved',
        };
      } catch (error) {
        // OFF being down is "no barcode signal", never a broken tick (OFF.md §5).
        this.lastError = `off: ${errorMessage(error)}`;
        barcode = {
          digits: snapshot.barcode.digits,
          text: null,
          source: 'unresolved',
        };
        this.lastBarcode = {
          digits: snapshot.barcode.digits,
          text: null,
          source: 'unresolved',
        };
      }
    }

    const unchecked = this.items.filter(item => !item.done);
    if (unchecked.length === 0) {
      const output = emptyOutput(this.items);
      this.state = output.state;
      this.lastOutput = output;
      return this.makeTick(at, 'no-items', output, null, barcode, [], 0, ocrTexts);
    }

    // 2. Item vectors (embed once per docText; a failure keeps the last output).
    const embedError = await this.ensureItemVectors();
    if (embedError !== null) {
      return this.failedTick(at, embedError, barcode, ocrTexts);
    }

    // 3. Text queries: barcode first, then OCR lines, ≤16 (pool-order fix). Built from the OCR
    // batch taken above — `pool.textQueries` cannot be used here because `takeOCR` cleared it.
    const textQueries = buildTextQueries(
      snapshot.barcode === null ? null : barcodeName,
      ocrTexts,
      this.maxTextQueries,
    );
    const textVectors: number[][] = [];
    for (const query of textQueries) {
      const vector = await this.embedQuery(query);
      if (vector === null) {
        return this.failedTick(at, this.lastError ?? 'query embed failed', barcode, ocrTexts);
      }
      textVectors.push(vector);
    }

    const imageVectors = snapshot.images.map(entry => [...entry.vector]);
    const queries: RankQueries = {text: textVectors, image: imageVectors};

    // 4. ts-core owns scores, gates, image guard, hysteresis and order.
    const rankItems: RankItem[] = this.items.map(item => {
      const vec = item.done ? null : this.itemVectors.get(docText(item)) ?? null;
      return {...item, vec};
    });
    const output = rank(rankItems, queries, this.state, barcodeName, {
      dims: this.dims,
      prevOutput: this.lastOutput,
    });
    this.state = output.state;
    this.lastOutput = output;

    const reason: ScanTickReason = !output.ranked
      ? 'no-signal'
      : output.topId === null
        ? 'no-hero'
        : 'hero';
    return this.makeTick(
      at,
      reason,
      output,
      output.topId,
      barcode,
      textQueries,
      imageVectors.length,
      ocrTexts,
    );
  }

  private makeTick(
    at: number,
    reason: ScanTickReason,
    output: RankOutput,
    heroId: string | null,
    barcode: ScanTick['barcode'],
    textQueries: string[],
    imageQueries: number,
    ocrLines: string[],
  ): ScanTick {
    return {
      at,
      reason,
      output,
      heroId,
      barcode,
      textQueries,
      imageQueries,
      ocrLines,
      error: reason === 'embed-unavailable' ? this.lastError : null,
    };
  }

  private failedTick(
    at: number,
    error: string,
    barcode: ScanTick['barcode'],
    ocrLines: string[],
  ): ScanTick {
    this.lastError = error;
    const output = this.lastOutput ?? emptyOutput(this.items);
    return this.makeTick(
      at,
      'embed-unavailable',
      output,
      output.topId,
      barcode,
      [],
      0,
      ocrLines,
    );
  }

  /** A vector the ranker will accept: exactly `dims` finite numbers. */
  private hasValidVector(vector: readonly number[] | undefined): boolean {
    return (
      Array.isArray(vector) &&
      vector.length === this.dims &&
      vector.every(value => typeof value === 'number' && Number.isFinite(value))
    );
  }

  /** Embed every unchecked item doc that has no vector yet. Returns an error string or null. */
  private async ensureItemVectors(): Promise<string | null> {
    const missing: {key: string; text: string}[] = [];
    const seen = new Set<string>();
    for (const item of this.items) {
      if (item.done) {
        continue;
      }
      const key = docText(item);
      if (this.itemVectors.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      missing.push({key, text: key});
    }
    if (missing.length === 0) {
      return null;
    }
    try {
      const vectors = await this.embedder.embedDocs(missing.map(entry => entry.text));
      if (vectors.length !== missing.length) {
        return `embedDocs returned ${vectors.length} vectors for ${missing.length} docs`;
      }
      vectors.forEach((vector, index) => {
        const entry = missing[index] as {key: string};
        if (this.hasValidVector(vector)) {
          this.itemVectors.set(entry.key, vector);
        }
      });
      const first = vectors.find(vector => Array.isArray(vector) && vector.length > 0);
      if (first !== undefined && this.hasValidVector(first)) {
        this.dims = first.length;
      }
      const stillMissing = missing.filter(entry => !this.itemVectors.has(entry.key));
      return stillMissing.length === 0
        ? null
        : `${stillMissing.length} item vectors are malformed`;
    } catch (error) {
      return `item embed: ${errorMessage(error)}`;
    }
  }

  private async embedQuery(text: string): Promise<number[] | null> {
    const cached = this.queryVectors.get(text);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const vector = await this.embedder.embedQuery(text);
      if (!this.hasValidVector(vector)) {
        this.lastError = `query vector has ${vector.length} dims, expected ${this.dims}`;
        return null;
      }
      this.queryVectors.set(text, vector);
      return vector;
    } catch (error) {
      this.lastError = `query embed: ${errorMessage(error)}`;
      return null;
    }
  }
}
