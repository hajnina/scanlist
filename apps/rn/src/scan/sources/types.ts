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
