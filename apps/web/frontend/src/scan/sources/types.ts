/**
 * Scan sources (Track C) — the web-local signal contract.
 *
 * Field names are deliberately identical to Track A's contract
 * (`apps/rn/src/scan/sources/types.ts`, card A1) and Track B's `ScanSignal` so the three builds
 * can be compared side by side:
 *
 *   { source: 'barcode' | 'ocr' | 'image', text, confidence, at? }
 *
 * `at` (ms, `Date.now()`) is the only addition: on the web every source runs off one rAF/timer
 * loop and the ranker needs the frame timestamp for RANK.md §2.2's "4 most recent image vectors
 * from the last 2000 ms" window. The RN/Kotlin contracts carry the same information on the
 * companion frame object.
 *
 * Difference in *payload* only: RN hands a base64 JPEG + a file path (`CameraFrame`) because ML Kit
 * reads paths; the browser has a Canvas and posts the bytes, so {@linkcode CapturedFrame} carries a
 * `Blob`. `width`, `height` and `capturedAt` keep their names.
 */

export type ScanSourceName = 'barcode' | 'ocr' | 'image';

export interface ScanSignal {
  source: ScanSourceName;
  /** Barcode digits, one OCR line, or {@linkcode IMAGE_QUERY_MARKER} for an image query. */
  text: string;
  /** 0..1 — a product barcode exact match reports 1 (see A4's `barcodeSignal`). */
  confidence: number;
  /** `Date.now()` at the moment the evidence was captured. */
  at?: number;
}

/** `ScanSignal.text` for an image query that carries no text of its own (same as A4). */
export const IMAGE_QUERY_MARKER = 'image:frame';

/** One sampled camera frame: a 384 px JPEG plus the source geometry and capture time. */
export interface CapturedFrame {
  /** JPEG bytes, exactly as `canvas.toBlob('image/jpeg')` produced them (no base64). */
  jpeg: Blob;
  /** Encoded (post-scale) width in pixels. */
  width: number;
  /** Encoded (post-scale) height in pixels. */
  height: number;
  /** `Date.now()` at capture, ms — travels with the embedding result (newest-frame-wins upload). */
  capturedAt: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * The seam card C7 ("in-browser embedder" spike) flips: a frame goes to whichever
 * {@linkcode FrameEmbedder} is configured. The server implementation is
 * `createServerImageEmbedder` (POST /embed/image); a local WebGPU/WASM embedder implements the
 * same interface without touching the capture loop.
 */
export interface FrameEmbedder {
  embed(frame: CapturedFrame): Promise<ImageEmbedding>;
  /** Release model/session resources; no-op for the HTTP embedder. */
  dispose?(): Promise<void>;
}

export interface ImageEmbedding {
  /** 256-d unit vector (L2-normalised, Matryoshka truncation — RANK.md §2). */
  vector: number[];
  dims: number;
  /** Server-reported embedding time from `x-embed-ms`, ms; `null` when the header is absent. */
  embedMs: number | null;
  backend: string;
  model: string;
}

/** What a single-frame upload produced, timestamp included (newest-frame-wins, see uploader.ts). */
export interface FrameEmbedResult {
  frame: CapturedFrame;
  embedding: ImageEmbedding;
}
