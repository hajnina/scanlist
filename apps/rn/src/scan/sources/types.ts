/**
 * Scan sources (Track A) — pluggable signals that feed the ranking (docs/ARCHITECTURE.md):
 *   1. barcode   (native barcode/ML Kit module → Open Food Facts name)
 *   2. text OCR  (on-device OCR → visible words)
 *   3. image     (the camera frame straight into EmbeddingGemma 2)
 *
 * Card A1: the interface only. The implementations land in the scan cards; keeping the shape
 * here means the UI in src/scan/ui can be written against it.
 */

export interface ScanSignal {
  source: ScanSourceName;
  /** Barcode digits, OCR words, or a marker for a raw image query. */
  text: string;
  /** 0..1 — barcode exact matches report 1. */
  confidence: number;
}

export type ScanSourceName = 'barcode' | 'ocr' | 'image';

export interface ScanSource {
  name: ScanSourceName;
  /** Start emitting signals; may be called again after stop(). */
  start(onSignal: (signal: ScanSignal) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Card A4 — one sampled camera frame.
 *
 * The camera is sampled at ~2.5 fps (see ./captureLoop); the same capture feeds all three sources
 * so barcode, OCR and image embedding see the exact same picture:
 *  - `filePath` is the JPEG on disk, which is what ML Kit's static-image APIs read
 *    (`processImageBarcodeScanning` / `processImageTextRecognition` accept a path or `file://` URI);
 *  - `jpegBase64` is the same JPEG as bytes, for the embedder / backend (`Photo.getFileDataAsync`).
 */
export interface CameraFrame {
  /** JPEG bytes, base64, no `data:` prefix. */
  jpegBase64: string;
  /** Filesystem path (no scheme) of the same JPEG, e.g. `/data/user/0/…/cache/photo-1.jpg`. */
  filePath: string;
  width: number;
  height: number;
  /** `Date.now()` at capture, ms. */
  capturedAt: number;
  /**
   * Deletes the temp JPEG behind {@linkcode filePath}, when the capturer knows how (card A6).
   *
   * The feed calls it after a grace period (async readers may still have the path open) and on
   * `releaseAll()`; nothing else has to remember the file. Absent for synthetic/test frames.
   */
  release?: () => void | Promise<void>;
}

/** Fan-out of captured frames to the sources attached to one camera session. */
export interface FrameFeed {
  /** Returns an unsubscribe function; safe to call more than once. */
  subscribe(listener: (frame: CameraFrame) => void): () => void;
}
