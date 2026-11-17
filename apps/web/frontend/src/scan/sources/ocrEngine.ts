/**
 * Lazy Tesseract.js OCR engine (card C4: "optional Tesseract.js OCR (lazy-loaded)").
 *
 * BarcodeDetector only reads codes; OCR text is what lets the ranker compare "what the shelf says"
 * to the list. Tesseract.js is heavy (worker script + wasm core + `eng` traineddata fetched on first
 * use, several MB), so it is:
 *
 *  - **dynamically imported** on the first `recognize()` — Vite emits it as a separate chunk, the
 *    main bundle never contains it;
 *  - **opt-in**: nothing constructs this engine unless the scan screen asks for OCR; barcode-only
 *    scanning downloads nothing;
 *  - **one worker**, reused across frames (`createWorker` costs ~1 s), terminated by `dispose()`.
 *
 * The engine returns the same {@linkcode OcrResultLike} shape as `ocr.ts` consumes, so the per-line
 * shaping (one query per line, per-line confidence, cap-after-filter) is identical whether the lines
 * came from Tesseract or from a fake in tests.
 */

import type { OcrBlockLike, OcrLineLike, OcrResultLike } from './ocr';

export interface TesseractLineLike {
  text?: string | null;
  /** Tesseract reports 0..100, not 0..1. */
  confidence?: number | null;
}

export interface TesseractPageLike {
  text?: string | null;
  blocks?: ReadonlyArray<{
    paragraphs?: ReadonlyArray<{ lines?: readonly TesseractLineLike[] | null }> | null;
  }> | null;
}

export interface TesseractWorkerLike {
  recognize(
    image: Blob,
    options?: Record<string, unknown>,
    output?: { blocks?: boolean; text?: boolean },
  ): Promise<{ data: TesseractPageLike }>;
  terminate(): Promise<unknown>;
}

export interface TesseractModuleLike {
  createWorker(
    langs?: string | string[],
    oem?: unknown,
    options?: Record<string, unknown>,
  ): Promise<TesseractWorkerLike>;
}

export interface OcrEngine {
  recognize(image: Blob): Promise<OcrResultLike>;
  dispose(): Promise<void>;
}

/** Tesseract page → the block/line shape `extractOcrLines` understands (confidence scaled to 0..1). */
export function tesseractPageToOcrResult(page: TesseractPageLike): OcrResultLike {
  const blocks: OcrBlockLike[] = [];
  for (const block of page.blocks ?? []) {
    const lines: OcrLineLike[] = [];
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          text: line.text ?? '',
          confidence:
            typeof line.confidence === 'number' && Number.isFinite(line.confidence)
              ? line.confidence / 100
              : null,
        });
      }
    }
    if (lines.length > 0) blocks.push({ lines });
  }
  return blocks.length > 0 ? { blocks } : { text: page.text ?? '' };
}

export interface TesseractEngineOptions {
  /** Tesseract language pack(s); `eng` is ~4 MB of traineddata on first use. */
  langs?: string | string[];
  /** Tesseract `OEM` (0 = legacy, 1 = LSTM only, …); default is Tesseract's own DEFAULT. */
  oem?: unknown;
  /** Extra `createWorker` options (e.g. `workerPath`, `langPath` for a self-hosted copy). */
  workerOptions?: Record<string, unknown>;
  /** Injectable loader for tests; defaults to the lazy dynamic import. */
  load?: () => Promise<TesseractModuleLike>;
}

function defaultLoad(): Promise<TesseractModuleLike> {
  // Dynamic import: a separate Vite chunk, fetched only when OCR is actually used.
  return import('tesseract.js').then((module) => module as unknown as TesseractModuleLike);
}

export function createTesseractEngine({
  langs = 'eng',
  oem,
  workerOptions = {},
  load = defaultLoad,
}: TesseractEngineOptions = {}): OcrEngine {
  let workerPromise: Promise<TesseractWorkerLike> | undefined;
  let disposed = false;

  function worker(): Promise<TesseractWorkerLike> {
    if (workerPromise === undefined) {
      workerPromise = load().then((module) => module.createWorker(langs, oem, workerOptions));
    }
    return workerPromise;
  }

  return {
    async recognize(image: Blob): Promise<OcrResultLike> {
      if (disposed) throw new Error('OCR engine is disposed');
      const active = await worker();
      const { data } = await active.recognize(image, {}, { blocks: true, text: true });
      return tesseractPageToOcrResult(data);
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (workerPromise === undefined) return;
      const pending = workerPromise;
      workerPromise = undefined;
      try {
        const active = await pending;
        await active.terminate();
      } catch {
        // A worker that failed to start has nothing to terminate.
      }
    },
  };
}
