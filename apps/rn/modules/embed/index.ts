/**
 * Contract for the future `modules/embed` TurboModule (a thin wrapper over the Kotlin
 * `shared/android-embed` engine). Card A1: types only — no native module is linked yet, so the
 * skeleton stays buildable without model weights or an NDK.
 */
export type EmbedBackend = 'npu' | 'gpu' | 'cpu';

export interface Embedder {
  name: string;
  backend: EmbedBackend;
  dims: number;
  /** Document texts (item names + aliases + section path) — one vector per text. */
  embedDocs(texts: string[]): Promise<number[][]>;
  /** Query text (barcode name / OCR words) or a raw image query. */
  embedQuery(text: string): Promise<number[]>;
}
