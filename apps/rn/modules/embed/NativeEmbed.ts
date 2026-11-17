/**
 * The native half of `modules/embed` (card A3): the shape of the `Embed` module registered by
 * `apps/rn/android/.../embed/EmbedPackage.kt`, and the one place that looks it up.
 *
 * On the new architecture RN 0.88 resolves the legacy `Embed` module through the legacy-module
 * interop layer, so `TurboModuleRegistry.get('Embed')` works; `NativeModules.Embed` is the second
 * road (and what some Jest setups expose). No codegen spec is involved — see `index.ts`.
 *
 * Vectors cross the bridge as base64 of little-endian float32 (`EmbedVectors.kt`), never as a JSON
 * array of numbers: three list items are 768 floats per scan.
 */
import {NativeModules, TurboModuleRegistry} from 'react-native';

/** Name the Kotlin module registers under (`EmbedModule.NAME`). */
export const NATIVE_MODULE_NAME = 'Embed';

/** Constants the module returns synchronously (`getConstants()`); `backend` is `none` before the first call. */
export interface NativeEmbedConstants {
  name: string;
  modelId: string;
  /** `dims.active` from `prompts.json` (256 today). */
  dims: number;
  backend: string;
  /** File name of the `.litertlm` bundle the app expects in its files dir. */
  modelFile: string;
  modelPresent: boolean;
  supportsImages: boolean;
  linked: boolean;
}

export interface NativeEmbedBatch {
  /** base64 of little-endian float32, one per input text. */
  vectors: string[];
  dims: number;
  backend: string;
  /** Time of the amortised call itself (model already open). */
  latencyMs: number;
  /** Time the model open + self-test took, if this call paid it (0 afterwards). */
  openMs: number;
}

export interface NativeEmbedSingle {
  vector: string;
  dims: number;
  backend: string;
  latencyMs: number;
  openMs: number;
}

export interface NativeEmbedStatus {
  backend: string;
  dims: number;
  supportsImages: boolean;
  modelId: string;
  modelPresent: boolean;
  /** Absolute path the app reads (or would read) the bundle from. */
  modelPath: string;
  modelFile: string;
  open: boolean;
  /** `scripts/model.sh push <package>` — the fix for a missing model. */
  hint: string;
}

export interface NativeEmbedModule {
  getConstants?(): NativeEmbedConstants;
  embedDocs(texts: string[]): Promise<NativeEmbedBatch>;
  embedQuery(text: string): Promise<NativeEmbedSingle>;
  embedImage(base64: string | null, uri: string | null): Promise<NativeEmbedSingle>;
  status(): Promise<NativeEmbedStatus>;
  close(): Promise<void>;
}

let cached: NativeEmbedModule | null | undefined;

/**
 * The `Embed` native module, or null when it is not linked (an iOS build, a Jest environment, a
 * binary built before card A3). Resolved once; a missing module is a state the UI can show.
 */
export function getNativeEmbed(): NativeEmbedModule | null {
  if (cached !== undefined) {
    return cached;
  }
  cached = lookup();
  return cached;
}

function lookup(): NativeEmbedModule | null {
  try {
    const turbo = TurboModuleRegistry.get(NATIVE_MODULE_NAME) as unknown;
    if (turbo) {
      return turbo as NativeEmbedModule;
    }
  } catch {
    // Not on the new architecture (or the proxy is absent): fall through to NativeModules.
  }
  const legacy = (NativeModules as Record<string, unknown>)[NATIVE_MODULE_NAME];
  return (legacy as NativeEmbedModule | undefined) ?? null;
}

/** Synchronous constants of the module, or null when it is not linked. */
export function nativeEmbedConstants(): NativeEmbedConstants | null {
  const native = getNativeEmbed();
  if (!native || typeof native.getConstants !== 'function') {
    return null;
  }
  return native.getConstants();
}

/** Test seam: forget the resolved module (the next lookup hits the bridge again). */
export function resetNativeEmbedCache(): void {
  cached = undefined;
}
