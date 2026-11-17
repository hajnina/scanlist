/**
 * The prefix set the engine is actually using (card A6) — the RN twin of B6's `PrefixInfo.kt`.
 *
 * Read from the bundled `prompts.json` by the native module (`Embed.status().prompts`), never
 * hard-coded: docs/ARCHITECTURE.md says the prefixes live in `shared/spec/prompts.json`, and a flip
 * of `active` in the spec must show up here after an asset re-sync with no code change.
 *
 * Display rule (B6): prefixes are `prefix + trim(text)`, so a trailing space inside the prefix is
 * load-bearing and invisible in a monospace line. Quote it and name the trailing space instead of
 * letting the reader guess; an empty prefix is called empty, not rendered as a blank row.
 */
import {DEFAULT_DIMS} from '../../modules/embed';

/** The prefix set as the screen shows it (adapted from the bridge's `prompts` map). */
export interface PrefixInfo {
  /** `mnemothera` | `modelcard` — prompts.json's `active`. */
  active: string;
  version: number;
  model: string;
  /** Includes the load-bearing trailing space. */
  docPrefix: string;
  queryPrefix: string;
  /** Empty today: images take no prefix. */
  imagePrefix: string;
  /** Matryoshka size the embedder returns (`dims.active`). */
  dims: number;
  /** The model's native size (768). */
  nativeDims: number;
}

/** The native `prompts` map (Prompts.kt serialised by EmbedModule.status). All fields optional. */
export interface NativePrompts {
  active?: unknown;
  version?: unknown;
  model?: unknown;
  doc?: unknown;
  query?: unknown;
  image?: unknown;
  dims?: unknown;
  nativeDims?: unknown;
}

const DEFAULT_NATIVE_DIMS = 768;

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

/**
 * Adapts the bridge map to the screen shape, or `null` when there is no usable set (old binary
 * without the field, native module absent, an `active` key with no prefixes at all).
 *
 * `fallbackDims` is the engine's reported active dims, used when the prompts map omits `dims`.
 */
export function prefixInfoFromNative(
  map: NativePrompts | null | undefined,
  fallbackDims: number = DEFAULT_DIMS,
): PrefixInfo | null {
  if (map === null || map === undefined || typeof map !== 'object') {
    return null;
  }
  const active = stringOf(map.active).trim();
  if (active === '') {
    return null;
  }
  const docPrefix = stringOf(map.doc);
  const queryPrefix = stringOf(map.query);
  if (docPrefix === '' && queryPrefix === '') {
    return null;
  }
  return {
    active,
    version: positiveInt(map.version, 0),
    model: stringOf(map.model),
    docPrefix,
    queryPrefix,
    imagePrefix: stringOf(map.image),
    dims: positiveInt(map.dims, fallbackDims),
    nativeDims: positiveInt(map.nativeDims, DEFAULT_NATIVE_DIMS),
  };
}

/** "mnemothera · v1 · 768→256" */
export function prefixSummary(info: PrefixInfo): string {
  return `${info.active} · v${info.version} · ${info.nativeDims}→${info.dims}`;
}

/** `"prefix: " · trailing space` — the invisible character is named, not silently dropped. */
export function describePrefix(prefix: string): string {
  if (prefix === '') {
    return 'empty';
  }
  return prefix.endsWith(' ')
    ? `"${prefix}" · trailing space`
    : `"${prefix}"`;
}

export function docPrefixLine(info: PrefixInfo): string {
  return describePrefix(info.docPrefix);
}

export function queryPrefixLine(info: PrefixInfo): string {
  return describePrefix(info.queryPrefix);
}

/** Images take no prefix today; say so instead of showing an empty string. */
export function imagePrefixLine(info: PrefixInfo): string {
  return info.imagePrefix === ''
    ? 'none (raw image)'
    : describePrefix(info.imagePrefix);
}
