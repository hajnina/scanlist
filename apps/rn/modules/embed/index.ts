/**
 * `modules/embed` — EmbeddingGemma 2 for Track A (card A3).
 *
 * Track A does not embed in JavaScript: this is a thin, typed Promise wrapper over the **same Kotlin
 * engine** Track B uses (`shared/android-embed`, card S5), reached through the `Embed` native module
 * (`apps/rn/android/app/src/main/java/dev/hajnina/scanlist/rn/embed/`). Both tracks therefore compare
 * UI/runtime layers on identical model code (docs/ARCHITECTURE.md, "Embedding backends").
 *
 * Two layers, on purpose:
 *
 *  - `embedDocs` / `embedQuery` / `embedImage` / `embedStatus` / `closeEmbed` — the detailed calls.
 *    They return the call metadata the dev screen and a future settings screen need (backend, dims,
 *    latency, model-open time).
 *  - `embedder` (also `getEmbedder()`) — the cross-track `Embedder` contract from
 *    docs/ARCHITECTURE.md: `name`, `backend`, `dims`, `embedDocs`, `embedQuery`, `embedImage`.
 *    A2/A4/A5 import this one.
 *
 * Vectors are transferred as base64 of little-endian float32 (`EmbedVectors.kt`) and decoded here
 * into a `Float32Array` first (`base64ToFloat32`), so nothing JSON-encodes 256-number arrays.
 *
 * Errors are rejected as `EmbedError` with a stable `code`. The expected state on a phone without the
 * model bundle is `E_MODEL_MISSING`; the dev screen renders it as a hint, not a crash.
 */
/* eslint-disable no-bitwise -- base64 decoding is bit manipulation; the shifts are the algorithm. */
import {
  getNativeEmbed,
  nativeEmbedConstants,
  resetNativeEmbedCache,
  type NativeEmbedModule,
  type NativeEmbedStatus,
  type NativePrompts,
} from './NativeEmbed';

export type EmbedBackend = 'npu' | 'gpu' | 'cpu' | 'none';

/** One image query: raw JPEG bytes (base64) or a `file://` / `content://` / plain path. */
export type EmbedImageInput = {base64: string} | {uri: string};

/**
 * The cross-track contract (docs/ARCHITECTURE.md). `backend`/`dims` are the values of the last
 * successful call (or the module's constants before the first one: `none` / `dims.active`).
 */
export interface Embedder {
  /** Engine identity, `'android-embed'` — not the model id. */
  name: string;
  backend: EmbedBackend;
  dims: number;
  /** Document texts (item names + aliases + section path) — one vector per text. */
  embedDocs(texts: string[]): Promise<number[][]>;
  /** Query text (barcode name / OCR words). */
  embedQuery(text: string): Promise<number[]>;
  /** Raw camera frame. Images take no prefix. */
  embedImage(image: EmbedImageInput): Promise<number[]>;
}

/** Result of a batch call, including what it cost. */
export interface EmbedBatch {
  vectors: number[][];
  backend: EmbedBackend;
  dims: number;
  /** Amortised time of this call (the model was already open). */
  latencyMs: number;
  /** Time the model open + backend self-test took, when this call paid it (0 afterwards). */
  openMs: number;
}

/** Result of a single-vector call. */
export interface EmbedSingle {
  vector: number[];
  backend: EmbedBackend;
  dims: number;
  latencyMs: number;
  openMs: number;
}

/** Engine + model state; never rejects for a missing model. */
export interface EmbedStatus {
  /** Whether the `Embed` native module is in this binary at all. */
  linked: boolean;
  backend: EmbedBackend;
  dims: number;
  supportsImages: boolean;
  modelId: string;
  modelPresent: boolean;
  modelPath: string;
  modelFile: string;
  /** Whether the model is open right now (a call would not pay `openMs`). */
  open: boolean;
  /** The command that fixes a missing model (`scripts/model.sh push <package>`). */
  hint: string;
  /** Size of the bundle on disk (0 when absent). Card A6's model card. */
  modelBytes: number;
  /** Whether this process can read the bundle (false for a shell-owned adb push). */
  modelReadable: boolean;
  /** Pinned sha256, shown as EXPECTED — never recomputed on the device. */
  modelSha256: string;
  /** The prefix set from the bundled prompts.json, or null when unavailable. */
  prompts: NativePrompts | null;
}

/** Stable error codes crossing the bridge (Kotlin `EmbedModule.codeOf`). */
export const EMBED_ERROR = {
  /** The native module is not in this build (iOS, Jest, a binary predating card A3). */
  noModule: 'E_NO_MODULE',
  /** No `.litertlm` in the app's files dir — expected until card B0/S6 provisions it. */
  modelMissing: 'E_MODEL_MISSING',
  /** Every backend of the ladder failed (GPU and CPU). */
  noBackend: 'E_NO_BACKEND',
  /** The engine cannot serve this call (images on a text-only bundle, closed embedder). */
  unavailable: 'E_UNAVAILABLE',
  /** Bad arguments from JS. */
  input: 'E_INPUT',
  /** The image could not be read. */
  image: 'E_IMAGE',
  /** Anything else the engine threw. */
  embed: 'E_EMBED',
  /** A malformed base64 vector from the native side. */
  codec: 'E_CODEC',
} as const;

/** An embedding failure with a machine-readable `code` (see `EMBED_ERROR`). */
export class EmbedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EmbedError';
    this.code = code;
    // Hermes/Babel class extends of builtins: keep `instanceof EmbedError` working.
    Object.setPrototypeOf(this, EmbedError.prototype);
  }
}

/** `prompts.json` `dims.active` today; used until the native module says otherwise (Embedder.DEFAULT_DIMS). */
export const DEFAULT_DIMS = 256;

/** `EmbedderConfig.DEFAULT_MODEL_ID` in `shared/android-embed`. */
export const DEFAULT_MODEL_ID = 'embeddinggemma-2-740m';

/** `EmbedModule.ENGINE_NAME` in Kotlin. */
export const ENGINE_NAME = 'android-embed';

// ---------------------------------------------------------------------------------------------
// base64 -> Float32Array (little-endian, what the Kotlin side writes)
// ---------------------------------------------------------------------------------------------

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: number[] = (() => {
  const table = new Array<number>(256).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index++) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * Standard base64 (padding optional, whitespace ignored) to bytes. Hand-rolled because Hermes has no
 * `atob` guarantee; tested against Node's `Buffer` in `__tests__/embed.test.ts`.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const compact = base64.replace(/\s+/g, '').replace(/[=]+$/, '');
  if (compact.length % 4 === 1) {
    throw new EmbedError(EMBED_ERROR.codec, `invalid base64 length ${compact.length}`);
  }
  const out = new Uint8Array(Math.floor((compact.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < compact.length; index++) {
    const charCode = compact.charCodeAt(index);
    const value = charCode < 256 ? BASE64_LOOKUP[charCode] : -1;
    if (value < 0) {
      throw new EmbedError(
        EMBED_ERROR.codec,
        `invalid base64 character ${JSON.stringify(compact[index])} at ${index}`,
      );
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  return offset === out.length ? out : out.subarray(0, offset);
}

/** Decodes a native vector: 4 bytes per float, little-endian (matches `EmbedVectors.kt`). */
export function base64ToFloat32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  if (bytes.length % 4 !== 0) {
    throw new EmbedError(
      EMBED_ERROR.codec,
      `vector is ${bytes.length} bytes, expected a multiple of 4 (float32)`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.length / 4);
  for (let index = 0; index < vector.length; index++) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}

// ---------------------------------------------------------------------------------------------
// state: last known backend/dims, so the contract's sync fields mean something
// ---------------------------------------------------------------------------------------------

interface Known {
  backend: EmbedBackend;
  dims: number;
  supportsImages: boolean;
  modelId: string;
}

let known: Known | null = null;

function normalizeBackend(value: unknown): EmbedBackend {
  return value === 'npu' || value === 'gpu' || value === 'cpu' ? value : 'none';
}

function knownState(): Known {
  if (!known) {
    const constants = nativeEmbedConstants();
    known = {
      backend: normalizeBackend(constants?.backend),
      dims: typeof constants?.dims === 'number' ? constants.dims : DEFAULT_DIMS,
      supportsImages: constants?.supportsImages === true,
      modelId: constants?.modelId ?? DEFAULT_MODEL_ID,
    };
  }
  return known;
}

function remember(backend: unknown, dims: unknown, more?: Partial<Known>): EmbedBackend {
  const state = knownState();
  state.backend = normalizeBackend(backend);
  if (typeof dims === 'number' && dims > 0) {
    state.dims = dims;
  }
  if (more?.supportsImages !== undefined) {
    state.supportsImages = more.supportsImages;
  }
  if (more?.modelId) {
    state.modelId = more.modelId;
  }
  return state.backend;
}

function requireNative(): NativeEmbedModule {
  const native = getNativeEmbed();
  if (!native) {
    throw new EmbedError(
      EMBED_ERROR.noModule,
      "The `Embed` native module is not linked in this build. It ships with apps/rn/android " +
        '(card A3); iOS and Jest have no implementation.',
    );
  }
  return native;
}

/** Re-throws anything from the bridge as an `EmbedError` with the native `code` preserved. */
function wrapError(error: unknown): EmbedError {
  if (error instanceof EmbedError) {
    return error;
  }
  const shape = error as {code?: unknown; message?: unknown};
  const code = typeof shape?.code === 'string' ? shape.code : EMBED_ERROR.embed;
  const message =
    typeof shape?.message === 'string' && shape.message.length > 0
      ? shape.message
      : String(error);
  return new EmbedError(code, message);
}

function vectorsToArrays(vectors: string[]): number[][] {
  // Decode straight into Float32Array, then hand the contract plain arrays.
  return vectors.map(encoded => Array.from(base64ToFloat32(encoded)));
}

// ---------------------------------------------------------------------------------------------
// the detailed API
// ---------------------------------------------------------------------------------------------

/** Embeds list items (doc prefix). Each vector is `dims` long and L2-normalised. */
export async function embedDocs(texts: string[]): Promise<EmbedBatch> {
  const native = requireNative();
  try {
    const result = await native.embedDocs(texts);
    const backend = remember(result.backend, result.dims);
    return {
      vectors: vectorsToArrays(result.vectors),
      backend,
      dims: result.dims,
      latencyMs: result.latencyMs,
      openMs: result.openMs,
    };
  } catch (error) {
    throw wrapError(error);
  }
}

/** Embeds one scan query (query prefix). */
export async function embedQuery(text: string): Promise<EmbedSingle> {
  const native = requireNative();
  try {
    const result = await native.embedQuery(text);
    return single(result);
  } catch (error) {
    throw wrapError(error);
  }
}

/** Embeds one JPEG frame (no prefix). Give exactly one of `{base64}` or `{uri}`. */
export async function embedImage(image: EmbedImageInput): Promise<EmbedSingle> {
  const base64 = image && 'base64' in image ? image.base64 : undefined;
  const uri = image && 'uri' in image ? image.uri : undefined;
  const imageBase64 =
    typeof base64 === 'string' && base64.length > 0 ? base64 : null;
  const imageUri = typeof uri === 'string' && uri.length > 0 ? uri : null;
  if ((imageBase64 === null) === (imageUri === null)) {
    throw new EmbedError(
      EMBED_ERROR.input,
      'embedImage takes exactly one of {base64: string} or {uri: string}',
    );
  }
  const native = requireNative();
  try {
    const result = await native.embedImage(imageBase64, imageUri);
    return single(result);
  } catch (error) {
    throw wrapError(error);
  }
}

function single(result: {
  vector: string;
  backend: string;
  dims: number;
  latencyMs: number;
  openMs: number;
}): EmbedSingle {
  const vector = base64ToFloat32(result.vector);
  const backend = remember(result.backend, result.dims);
  return {
    vector: Array.from(vector),
    backend,
    dims: result.dims,
    latencyMs: result.latencyMs,
    openMs: result.openMs,
  };
}

/**
 * Engine + model state without opening the model. Resolves (never rejects) when the native module is
 * missing, so a screen can always render something useful.
 */
export async function embedStatus(): Promise<EmbedStatus> {
  const native = getNativeEmbed();
  if (!native) {
    return {
      linked: false,
      backend: 'none',
      dims: DEFAULT_DIMS,
      supportsImages: false,
      modelId: DEFAULT_MODEL_ID,
      modelPresent: false,
      modelPath: '',
      modelFile: 'embeddinggemma-2-740m.litertlm',
      open: false,
      hint: 'Rebuild apps/rn/android with card A3 (EmbedPackage) — this binary has no embed module.',
      modelBytes: 0,
      modelReadable: false,
      modelSha256: '',
      prompts: null,
    };
  }
  try {
    const status: NativeEmbedStatus = await native.status();
    const backend = remember(status.backend, status.dims, {
      supportsImages: status.supportsImages,
      modelId: status.modelId,
    });
    return {
      ...status,
      backend,
      linked: true,
      // Card A6 added these to the bridge; an older binary simply omits them.
      modelBytes: status.modelBytes ?? 0,
      modelReadable: status.modelReadable === true,
      modelSha256: status.modelSha256 ?? '',
      prompts: status.prompts ?? null,
    };
  } catch (error) {
    throw wrapError(error);
  }
}

/** Unloads the model; the next call reopens it through the GPU → CPU ladder. */
export async function closeEmbed(): Promise<void> {
  const native = requireNative();
  try {
    await native.close();
    known = null;
  } catch (error) {
    throw wrapError(error);
  }
}

/** The picker ids this bridge accepts (`SettingsController` persists the same strings). */
export const BACKEND_CHOICES = ['auto', 'gpu', 'cpu', 'npu'] as const;

/**
 * Card A6: persist the backend policy and unload any open engine, so the next call opens on the
 * chosen ladder. `auto` is the shipped GPU → CPU fallback; `gpu`/`cpu`/`npu` are strict, so a strict
 * choice can fail honestly instead of silently measuring another backend.
 */
export async function setBackend(choice: string): Promise<void> {
  if (!(BACKEND_CHOICES as readonly string[]).includes(choice)) {
    throw new EmbedError(
      EMBED_ERROR.input,
      `setBackend expects one of ${BACKEND_CHOICES.join(', ')}, got ${JSON.stringify(choice)}`,
    );
  }
  const native = requireNative();
  if (typeof native.setBackend !== 'function') {
    throw new EmbedError(
      EMBED_ERROR.unavailable,
      'This binary predates the settings picker (card A6) — rebuild apps/rn/android.',
    );
  }
  try {
    await native.setBackend(choice);
    known = null;
  } catch (error) {
    throw wrapError(error);
  }
}

/**
 * Card A6: delete a temp JPEG the scanner captured (`saveToTemporaryFileAsync`). The native side
 * refuses anything outside the app cache. This is the bridge's only file-system verb because the RN
 * app has no file-system dependency (AGENTS.md) and A4's capture loop produced ~30 MB/min of them.
 */
export async function deleteTempFile(
  path: string,
): Promise<{deleted: boolean; path: string}> {
  const native = requireNative();
  if (typeof native.deleteTempFile !== 'function') {
    // An older binary cannot delete: report "not deleted" instead of throwing on every frame.
    return {deleted: false, path};
  }
  try {
    return await native.deleteTempFile(path);
  } catch (error) {
    throw wrapError(error);
  }
}

// ---------------------------------------------------------------------------------------------
// the cross-track contract
// ---------------------------------------------------------------------------------------------

class NativeEmbedder implements Embedder {
  get name(): string {
    return ENGINE_NAME;
  }

  get backend(): EmbedBackend {
    return knownState().backend;
  }

  get dims(): number {
    return knownState().dims;
  }

  get supportsImages(): boolean {
    return knownState().supportsImages;
  }

  get modelId(): string {
    return knownState().modelId;
  }

  async embedDocs(texts: string[]): Promise<number[][]> {
    return (await embedDocs(texts)).vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await embedQuery(text)).vector;
  }

  async embedImage(image: EmbedImageInput): Promise<number[]> {
    return (await embedImage(image)).vector;
  }
}

/** The `Embedder` other Track A cards import (A2/A4/A5): one instance, one model per process. */
export const embedder: Embedder = new NativeEmbedder();

/** Same instance as `embedder`, for call sites that prefer a getter. */
export function getEmbedder(): Embedder {
  return embedder;
}

/** Test seam: drop the resolved native module and the cached backend/dims. */
export function resetEmbedStateForTests(): void {
  known = null;
  resetNativeEmbedCache();
}
