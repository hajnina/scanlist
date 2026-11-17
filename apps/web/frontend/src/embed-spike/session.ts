/**
 * The seam between the spike's measurement code and the real transformers.js session.
 *
 * `harness.ts` only ever sees `EmbedSession`, so vitest can drive the whole measurement flow with
 * a fake that returns canned 768-d vectors — no model, no WebGPU, no network in CI. `model.ts`
 * implements the same interface with `@huggingface/transformers` loaded from the HF CDN at runtime.
 */

/** An image already decoded by the loader (`load_image` returns a `RawImage`). Opaque here. */
export type ImageHandle = unknown;

export interface EmbedSession {
  /** Backend actually in use ("webgpu" | "wasm" | "fake"). */
  readonly device: string;
  /** Quantisation in use ("q4" | …). */
  readonly dtype: string;
  /** Text inputs in, one native-dimension (768) vector per input out. */
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  /**
   * Image inputs in, one vector each out. `groups` is a nested list: `[[a], [b]]` is two inputs
   * (the model card's rule). A flat `[a, b]` would be ONE blended input — see `embedImagesFlat`.
   */
  embedImages(groups: ImageHandle[][]): Promise<Float32Array[]>;
  /** Deliberately wrong shape, used once to demonstrate the trap: a flat list = one input. */
  embedImagesFlat?(images: ImageHandle[]): Promise<Float32Array>;
  /** Token counts from the model's own tokenizer; absent → the planner uses an estimate. */
  countTokens?(texts: string[]): Promise<number[]>;
  /** Decode an image URL into a handle (excluded from embed latency measurements). */
  loadImage?(url: string): Promise<ImageHandle>;
}

/** One weight file the loader fetched, with its total size when known. */
export interface WeightFile {
  file: string;
  bytes: number;
}

/** WebGPU adapter facts, kept verbatim so a report cannot be mistaken for a phone number. */
export interface AdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  features: string[];
  maxBufferSize: number;
}

/** Where the time went before the first embedding could run (all ms, monotonic clock). */
export interface LoadMetrics {
  device: string;
  dtype: string;
  /** Library fetch (CDN) + parse, measured around the dynamic `import()`. */
  libImportMs: number;
  /** `AutoConfig.from_pretrained` (small JSON). */
  configMs: number;
  /** `AutoModel.from_pretrained` — includes the weight download. */
  modelLoadMs: number;
  /** Tokenizer / processor construction. */
  auxMs: number;
  /** Sum of the above (plus bookkeeping). */
  totalMs: number;
  /** Bytes reported by transformers.js' progress callback (sum of per-file totals). */
  weightsBytes: number;
  files: WeightFile[];
  /** Time to the first progress event (≈ first byte), null if nothing was downloaded. */
  firstByteMs: number | null;
  /** Time of the last progress event. */
  lastByteMs: number | null;
  adapter: AdapterInfo | null;
}

export interface Timing {
  samples: number[];
  median: number;
  p90: number;
  min: number;
  max: number;
}

export interface BatchTiming {
  size: number;
  tokens: number;
  ms: number;
  perItemMs: number;
}

export interface ParitySummary {
  n: number;
  minCosine: number;
  medianCosine: number;
  maxAbsDiff: number;
  /** Id of the input with the lowest cosine, for the doc's "worst case" column. */
  worstId: string | null;
}

export interface FlatVsNestedTrap {
  flatCosineVsNested: number[];
  /** `true` when the flat input is demonstrably a different (blended) embedding. */
  differs: boolean;
}

export interface SpikeReport {
  generatedAt: string;
  /** Where this ran — repeated verbatim in EMBED_SPIKE.md, never presented as phone numbers. */
  environment: {
    userAgent: string;
    device: string;
    dtype: string;
    adapter: AdapterInfo | null;
    webgpu: boolean;
  };
  load: LoadMetrics | null;
  budgets: {
    maxBatchTokens: number;
    imagesPerBatch: number;
    docTokens: { id: string; tokens: number }[];
    /** Batches as item-index lists, so the doc can show the real grouping. */
    docBatches: number[][];
    docBatchTokens: number[];
  };
  text: {
    docCount: number;
    docTotalMs: number;
    batches: BatchTiming[];
    /** Cold: the very first text embedding after load. */
    coldFirstMs: number;
    /** Warm single-input latency (first sample discarded as warm-up). */
    singleQuery: Timing | null;
  };
  image: {
    single: Timing | null;
    batch: BatchTiming | null;
    /** Pre-normalisation length of the 256-slice — shows why re-normalisation is mandatory. */
    sliceNormMean: number;
  };
  parity: {
    docs: ParitySummary;
    queries: ParitySummary;
    images: ParitySummary;
    top1: { hits: number; total: number; misses: string[] };
  };
  traps: {
    imagesPerBatchAtMost: number;
    flatVsNested: FlatVsNestedTrap | null;
  };
  notes: string[];
}
