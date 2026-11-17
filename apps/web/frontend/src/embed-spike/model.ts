/**
 * The real `EmbedSession`: EmbeddingGemma 2 q4 through transformers.js 4.3.1 on WebGPU.
 *
 * Weights are fetched at RUNTIME from the Hugging Face Hub (`onnx-community/embeddinggemma-2-ONNX`,
 * Apache-2.0) into the browser's HTTP cache / OPFS — nothing is downloaded into the repository
 * (repo hard rule: no model weights in git). The library itself comes from the jsDelivr CDN, which
 * is why this module is a *standalone, dev-only* page: `package.json` does not depend on
 * transformers.js, so `npm run build` never bundles it and the production bundle is unchanged.
 *
 * API shape copied from the model card's Quick Start (`onnx-community/embeddinggemma-2-ONNX`
 * README, 2026-10-06): `AutoModel.from_pretrained(id, { config, device, dtype })`,
 * `processor(text, images)`, `model(inputs).sentence_embedding`, and the warning that
 * `processor(null, [[a], [b]])` is two inputs while `processor(null, [a, b])` is ONE blended input.
 */

import type {
  AdapterInfo,
  EmbedSession,
  ImageHandle,
  LoadMetrics,
  WeightFile,
} from "./session";

/** Pinned so every number in EMBED_SPIKE.md names its exact library version. */
export const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
export const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const MODEL_LICENSE = "Apache-2.0";

/** Tensors here are only read; the narrow shape keeps us free of a transformers.js dependency. */
interface TensorLike {
  dims: number[];
  data?: Float32Array;
  tolist(): unknown;
}

interface TokenizerLike {
  (text: string | string[], options?: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}

interface ProcessorLike {
  (
    text: string | string[] | null,
    images?: unknown,
    audio?: unknown,
    videos?: unknown,
  ): Promise<Record<string, TensorLike>>;
  image_processor?: { max_soft_tokens?: number };
}

interface ModelLike {
  (inputs: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}

interface TransformersLib {
  AutoConfig: { from_pretrained(id: string): Promise<Record<string, unknown>> };
  AutoModel: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<ModelLike> };
  AutoTokenizer: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<TokenizerLike> };
  AutoProcessor: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<ProcessorLike> };
  load_image(url: string): Promise<unknown>;
}

interface ProgressEvent {
  status: string;
  file?: string;
  name?: string;
  loaded?: number;
  total?: number;
}

export interface LoadOptions {
  /** Text-only: removes `vision_config` and `audio_config` (175 MB instead of 284 MB). */
  textOnly?: boolean;
  /** `"webgpu"` (required for q4) or `"wasm"` (expected to fail on q4/q8 — the spike records why). */
  device?: "webgpu" | "wasm";
  /** "q4" default; "q8" / "q4f16" exist but q4 is what the digest recommends. */
  dtype?: string;
  /** Progress log sink (the page prints it). */
  onProgress?: (line: string) => void;
}

/** Read the WebGPU adapter without pulling in @webgpu/types. */
export async function probeAdapter(): Promise<AdapterInfo | null> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return null;
  const adapter = (await gpu.requestAdapter()) as
    | {
        features?: Iterable<string>;
        limits?: { maxBufferSize?: number };
        info?: Partial<AdapterInfo>;
      }
    | null;
  if (!adapter) return null;
  return {
    vendor: adapter.info?.vendor ?? "unknown",
    architecture: adapter.info?.architecture ?? "unknown",
    device: adapter.info?.device ?? "unknown",
    description: adapter.info?.description ?? "",
    features: adapter.features ? [...adapter.features] : [],
    maxBufferSize: adapter.limits?.maxBufferSize ?? 0,
  };
}

function settle<T>(value: unknown): T {
  return value as T;
}

/**
 * Load the library + model and return a session plus the load metrics.
 * Throws on any failure; the page reports the message verbatim (a failure IS a result here).
 */
export async function createGemmaSession(
  options: LoadOptions = {},
): Promise<{ session: EmbedSession; load: LoadMetrics }> {
  const device = options.device ?? "webgpu";
  const dtype = options.dtype ?? "q4";
  const textOnly = options.textOnly ?? false;
  const log = options.onProgress ?? (() => {});
  const now = () => performance.now();

  const files = new Map<string, WeightFile>();
  let firstByte: number | null = null;
  let lastByte: number | null = null;

  const tStart = now();
  const adapter = await probeAdapter();
  log(
    adapter
      ? `WebGPU adapter: ${adapter.vendor}/${adapter.architecture} (maxBufferSize ${adapter.maxBufferSize})`
      : "WebGPU adapter: none — q4 on WASM is expected to fail (missing GatherBlockQuantized).",
  );

  const lib = settle<TransformersLib>(await import(/* @vite-ignore */ TRANSFORMERS_CDN));
  const libImportMs = now() - tStart;
  log(`transformers.js 4.3.1 imported in ${libImportMs.toFixed(0)} ms`);

  const tConfig = now();
  const config = await lib.AutoConfig.from_pretrained(MODEL_ID);
  if (textOnly) config["vision_config"] = null;
  config["audio_config"] = null; // never needed: audio is 189 MB of the 473 MB full q4 download.
  const configMs = now() - tConfig;
  log(`config loaded (textOnly=${String(textOnly)}) in ${configMs.toFixed(0)} ms`);

  const tModel = now();
  const model = await lib.AutoModel.from_pretrained(MODEL_ID, {
    config,
    device,
    dtype: textOnly ? { model: dtype } : { model: dtype, vision_encoder: dtype },
    progress_callback: (event: ProgressEvent) => {
      if (event.status === "progress" || event.status === "download" || event.status === "done") {
        const file = event.file ?? event.name ?? "?";
        if (firstByte === null && (event.loaded ?? 0) > 0) firstByte = now() - tStart;
        if ((event.loaded ?? 0) > 0) lastByte = now() - tStart;
        if (typeof event.total === "number" && event.total > 0) {
          files.set(file, { file, bytes: event.total });
        }
      }
      if (event.status === "ready") log(`model ready (${(now() - tStart).toFixed(0)} ms total)`);
    },
  });
  const modelLoadMs = now() - tModel;
  const weightsBytes = [...files.values()].reduce((sum, file) => sum + file.bytes, 0);
  log(`model loaded in ${modelLoadMs.toFixed(0)} ms (${(weightsBytes / 1e6).toFixed(1)} MB reported)`);

  const tAux = now();
  const tokenizer = await lib.AutoTokenizer.from_pretrained(MODEL_ID);
  const processor = textOnly ? null : await lib.AutoProcessor.from_pretrained(MODEL_ID);
  const auxMs = now() - tAux;

  const session: EmbedSession = {
    device,
    dtype,
    async embedTexts(texts: string[]): Promise<Float32Array[]> {
      const inputs = await tokenizer(texts, { padding: true });
      const output = await model(inputs);
      return sentences(output);
    },
    async embedImages(groups: ImageHandle[][]): Promise<Float32Array[]> {
      if (processor === null) throw new Error("text-only session: no vision encoder was loaded");
      const inputs = await processor(null, groups);
      const output = await model(inputs);
      return sentences(output);
    },
    async embedImagesFlat(handles: ImageHandle[]): Promise<Float32Array> {
      if (processor === null) throw new Error("text-only session: no vision encoder was loaded");
      const inputs = await processor(null, handles);
      const output = await model(inputs);
      const vectors = sentences(output);
      if (vectors.length !== 1) {
        throw new Error(`flat image list produced ${vectors.length} embeddings, expected 1`);
      }
      return vectors[0] as Float32Array;
    },
    async countTokens(texts: string[]): Promise<number[]> {
      const counts: number[] = [];
      for (const text of texts) {
        const encoded = await tokenizer(text, { padding: true });
        const ids = encoded["input_ids"];
        counts.push(ids ? (ids.dims[ids.dims.length - 1] as number) : 0);
      }
      return counts;
    },
    async loadImage(url: string): Promise<ImageHandle> {
      return lib.load_image(url);
    },
  };

  const load: LoadMetrics = {
    device,
    dtype,
    libImportMs,
    configMs,
    modelLoadMs,
    auxMs,
    totalMs: now() - tStart,
    weightsBytes,
    files: [...files.values()].sort((a, b) => b.bytes - a.bytes),
    firstByteMs: firstByte,
    lastByteMs: lastByte,
    adapter,
  };
  return { session, load };
}

/** `sentence_embedding` rows → one `Float32Array` per input (768-d, already L2-normalised). */
function sentences(output: Record<string, TensorLike>): Float32Array[] {
  const tensor = output["sentence_embedding"] ?? output["last_hidden_state"];
  if (!tensor) {
    throw new Error(`model output has no sentence_embedding (keys: ${Object.keys(output).join(", ")})`);
  }
  const rows = tensor.tolist() as number[][] | number[];
  const list = Array.isArray(rows[0]) ? (rows as number[][]) : [rows as number[]];
  return list.map((row) => Float32Array.from(row));
}
