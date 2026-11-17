/**
 * Scan controller (card C5): evidence in, one ts-core rank tick out.
 *
 * Framework-free on purpose: the component (`ScanScreen.tsx`) owns the DOM, the camera session and
 * the 400 ms tick timer; this class owns the evidence windows, the query pool, the embedding requests
 * and the ranker state. Tests drive it with synthetic `ScanSignal`s and a synchronous fake embedder —
 * no DOM, no camera, no network — which is where the pool-order and hero-gate guarantees are proven.
 *
 * Flow of one tick:
 *
 *   ScanSignal (barcode/ocr) ─┐
 *   FrameEmbedResult (image) ─┼─ evidence windows (TTL: barcode 4 s, OCR line 2.5 s, image 2 s/4)
 *                             ▼
 *              assembleQueryPool (barcode slot 0, OCR ≤15 beside it)
 *                             ▼
 *     EmbedPort.resolve{Queries,Docs} (cache hit now; missing → one background batch)
 *                             ▼
 *                ts-core rank() / decideTop()  ← prev state (EMA + hysteresis)
 *                             ▼
 *             ScanUiState (rows, nullable hero, chips) ─► onChange
 *
 * **Never auto-commit.** Nothing in this file calls `onToggle`; the screen's big tick button is the
 * only path to the list (card C5's "auto-rank + manual-tick" rule).
 */

import { flatten, unranked } from "@scanlist/ts-core";
import type { FloatVector, RankOutput, ScanList } from "@scanlist/ts-core";

import type { Clock } from "../sources/clock";
import { systemClock } from "../sources/clock";
import type { FrameEmbedResult, ScanSignal } from "../sources/types";

import type { OffPort } from "./offClient";
import {
  DEFAULT_POOL_LIMITS,
  assembleQueryPool,
  type BarcodeEvidence,
  type ImageEvidence,
  type OcrLineEvidence,
  type PoolLimits,
  type QueryPool,
} from "./pool";
import {
  docTextsOf,
  evaluateTick,
  heroStatus,
  sourceChips,
  toRows,
  type ScanRow,
  type SourceChipView,
} from "./ranking";
import type { EmbedPort } from "./textEmbedder";
import type { ScanPhase } from "./types";

/** Barcode history is bounded: only the newest few can ever be inside the 4 s hold. */
const MAX_BARCODE_EVIDENCE = 8;
/** Image history is trimmed to several windows so a slow tick cannot resurrect stale frames. */
const MAX_IMAGE_EVIDENCE = 12;

export interface ScanUiState {
  phase: ScanPhase;
  rows: ScanRow[];
  /** Null is a real state, not an error: RANK.md §6.2/§6.3 gates said "no hero". */
  hero: ScanRow | null;
  ranked: boolean;
  heroStatus: string;
  chips: SourceChipView[];
  /** Text/image vectors actually available to the ranker, how many are still embedding, and the cap. */
  queries: { text: number; image: number; max: number; pending: number };
  /** Item-document embedding progress (RANK.md §8: the tick is deferred until all are present). */
  prepared: { done: number; total: number };
  barcode: BarcodeEvidence | null;
  /** Transport/embedding error worth showing; null when the last tick was healthy. */
  error: string | null;
}

export interface ScanControllerOptions {
  list: ScanList;
  embed: EmbedPort;
  off: OffPort;
  clock?: Clock;
  limits?: PoolLimits;
  onChange?: (state: ScanUiState) => void;
}

export interface ScanController {
  /** Feed one shaped source signal (barcode digits / one OCR line / image marker). */
  ingestSignal(signal: ScanSignal): void;
  /** Feed one image vector when its upload result lands (C4 emits the marker at the same time). */
  ingestImage(result: FrameEmbedResult): void;
  /** Replace the list after a tick (the component passes the new `props.list` each render). */
  setList(list: ScanList): void;
  /** Run one rank tick. Cheap when nothing changed; the component calls it every 400 ms. */
  tick(now?: number): void;
  /** The last emitted state (also the initial preparing state before the first tick). */
  state(): ScanUiState;
  dispose(): void;
}

const EMPTY_POOL: QueryPool = {
  barcode: null,
  texts: [],
  images: [],
  droppedOcrLines: 0,
  liveOcrLines: 0,
  barcodeInPool: false,
};

export function createScanController(options: ScanControllerOptions): ScanController {
  const { embed, off, clock = systemClock, limits = DEFAULT_POOL_LIMITS, onChange } = options;

  let items = flatten(options.list);
  let barcodes: BarcodeEvidence[] = [];
  let ocrLines: OcrLineEvidence[] = [];
  let images: ImageEvidence[] = [];
  let previous: RankOutput | null = null;
  let disposed = false;

  function currentPool(now: number): QueryPool {
    return assembleQueryPool({ barcodes, ocrLines, images }, now, limits);
  }

  /** Merge OFF results into barcode evidence. The port is synchronous and starts its own request. */
  function syncOffEvidence(now: number): void {
    for (const evidence of barcodes) {
      if (now - evidence.at > limits.barcodeTtlMs) continue;
      const resolution = off.lookup(evidence.barcode);
      if (resolution.state === "pending") continue;
      evidence.state = resolution.state;
      evidence.text = resolution.text;
      if (resolution.error !== undefined) evidence.error = resolution.error;
      else delete evidence.error;
    }
  }

  function prune(now: number): void {
    barcodes = barcodes
      .filter(
        (entry) =>
          now - entry.at <= limits.barcodeTtlMs || entry.state === "pending",
      )
      .slice(-MAX_BARCODE_EVIDENCE);
    ocrLines = ocrLines.filter((line) => now - line.at <= limits.ocrLineTtlMs);
    images = images
      .filter((image) => now - image.capturedAt <= limits.imageWindowMs * 2)
      .slice(-MAX_IMAGE_EVIDENCE);
  }

  function itemVectors(): Map<string, FloatVector> {
    const docs = docTextsOf(items);
    const resolution = embed.resolveDocs(docs);
    const vectors = new Map<string, FloatVector>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] as (typeof items)[number];
      const vector = resolution.vectors.get(docs[index] as string);
      if (vector !== undefined) vectors.set(item.id, vector);
    }
    return vectors;
  }

  function buildState(
    pool: QueryPool,
    vectors: ReadonlyMap<string, FloatVector>,
    output: RankOutput | null,
    pendingTexts = 0,
  ): ScanUiState {
    // No tick yet or no query: ts-core's own "unranked" shape, so the table never invents scores.
    const table = toRows(output ?? unranked(items), items);

    const preparedTotal = items.length;
    const preparedDone = vectors.size;
    const embedError = embed.lastError();
    const queryError = stripError(embedError);

    return {
      phase: preparedDone < preparedTotal ? "preparing" : "ready",
      rows: table.rows,
      hero: table.hero,
      ranked: output?.ranked ?? false,
      heroStatus: heroStatus(table.hero, output?.ranked ?? false),
      chips: sourceChips(pool, limits.maxTextQueries),
      queries: {
        text: table.ranked ? pool.texts.length - pendingTexts : 0,
        image: pool.images.length,
        max: limits.maxTextQueries,
        pending: pendingTexts,
      },
      prepared: { done: preparedDone, total: preparedTotal },
      barcode: pool.barcode,
      error: queryError,
    };
  }

  function tick(now = clock.now()): void {
    if (disposed) return;
    prune(now);
    syncOffEvidence(now);

    const pool = currentPool(now);
    const vectors = itemVectors();
    const textResolution = embed.resolveQueries(pool.texts);

    let output: RankOutput | null = null;
    try {
      output = evaluateTick({
        items,
        itemVectors: vectors,
        textVectors: textResolution.vectors,
        texts: pool.texts,
        imageVectors: pool.images.map((image) => image.vector),
        prev: previous,
        barcodeName: pool.barcode?.text ?? null,
      });
      previous = output;
    } catch (error) {
      // A malformed vector must not kill the scan loop: keep the previous table, surface the error.
      emit({
        ...buildState(pool, vectors, previous, textResolution.pending.length),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    emit(buildState(pool, vectors, output, textResolution.pending.length));
  }

  function ingestSignal(signal: ScanSignal): void {
    if (disposed) return;
    const at = signal.at ?? clock.now();

    if (signal.source === "barcode") {
      const value = signal.text.trim();
      if (value === "") return;
      const existing = barcodes.find((entry) => entry.barcode === value);
      if (existing === undefined) {
        barcodes.push({ barcode: value, at, text: null, state: "pending" });
        if (barcodes.length > MAX_BARCODE_EVIDENCE) barcodes = barcodes.slice(-MAX_BARCODE_EVIDENCE);
      } else {
        existing.at = at;
      }
      return;
    }

    if (signal.source === "ocr") {
      const text = signal.text.trim();
      if (text === "") return;
      const existing = ocrLines.find((line) => line.text === text);
      if (existing === undefined) {
        ocrLines.push({ text, at, confidence: signal.confidence });
      } else {
        existing.at = at;
        existing.confidence = signal.confidence;
      }
      return;
    }

    // Image markers carry no vector of their own; the vector arrives through ingestImage. Counting
    // them here would make the chips claim evidence the ranker cannot use.
  }

  function ingestImage(result: FrameEmbedResult): void {
    if (disposed) return;
    images.push({ vector: result.embedding.vector, capturedAt: result.frame.capturedAt });
    if (images.length > MAX_IMAGE_EVIDENCE) images = images.slice(-MAX_IMAGE_EVIDENCE);
  }

  const initialVectors = itemVectors();
  let latestState = buildState(EMPTY_POOL, initialVectors, null);
  function emit(state: ScanUiState): void {
    latestState = state;
    onChange?.(state);
  }

  return {
    ingestSignal,
    ingestImage,
    setList(next: ScanList): void {
      if (disposed) return;
      items = flatten(next);
    },
    tick,
    state: () => latestState,
    dispose(): void {
      disposed = true;
      embed.dispose();
      off.dispose();
    },
  };
}

/** `lastError()` returns a transport message; the UI prefix explains where it came from. */
function stripError(message: string | null): string | null {
  return message === null || message === "" ? null : `Embedding server: ${message}`;
}
