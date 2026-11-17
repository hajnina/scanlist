/**
 * Model-bundle status for the settings screen (card A6) — the RN twin of B6's `ModelStatus.kt`.
 *
 * The screen probes **the file the embedding pipeline actually opens**
 * (`EmbedModel.candidates()` → `<filesDir>/models/embeddinggemma-2-740m.litertlm`), so a missing
 * bundle is reported exactly where the pipeline would fail. Only file facts are consulted
 * (existence, readability, size); the sha256 is deliberately **not** recomputed per visit (484 MB)
 * — the pinned hash is displayed as the EXPECTED label and `scripts/model.sh push/verify` checks
 * the on-device copy once.
 *
 * Everything here is a pure decision over `ModelFileFacts`, so Jest can cover every branch with a
 * fake file system and no 484 MB fixture.
 */

/** What the platform can tell us about the bundle path, without opening it. */
export interface ModelFileFacts {
  path: string;
  exists: boolean;
  /** Defaults to `true` (a path that exists and is readable is a file until proven otherwise). */
  isFile?: boolean;
  readable?: boolean;
  bytes?: number;
  lastModified?: number;
}

export type ModelStatus =
  | {kind: 'present'; path: string; bytes: number; lastModified: number}
  | {kind: 'missing'; path: string}
  | {kind: 'unreadable'; path: string; reason: string};

/** The honest status code the settings screen shows when there is no bundle (B6 parity). */
export const E_NO_MODEL = 'E_NO_MODEL';

/**
 * Size of `embeddinggemma-2-740m.litertlm` (scripts/model.sh `MODEL_SIZE`, docs/ARCHITECTURE.md).
 * Copied as a display pin, like `ModelProbe.EXPECTED_BYTES` on the Kotlin track; the push script
 * remains the authority that verifies it on the device.
 */
export const EXPECTED_MODEL_BYTES = 484_622_336;

/**
 * sha256 of the pinned bundle (scripts/model.sh `MODEL_SHA256`,
 * `EmbedderConfig.DEFAULT_MODEL_SHA256`). Displayed as an EXPECTED label only — never computed in
 * the app (a 484 MB read on every settings visit would be dishonest about "instant settings").
 */
export const EXPECTED_MODEL_SHA256 =
  'e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c';

/**
 * The fix for E_NO_MODEL. The native module's `status()` carries the package-specific command
 * (`scripts/model.sh push <package>`); this is the fallback when the bridge is absent.
 */
export const PUSH_HINT =
  'Push it with scripts/model.sh push <package> --dest internal (or --dest both), then re-open settings.';

/** Filesystem status from plain facts. Never throws; empty/negative sizes are unreadable. */
export function modelStatusFromFacts(facts: ModelFileFacts): ModelStatus {
  const {path} = facts;
  if (!facts.exists) {
    return {kind: 'missing', path};
  }
  if (facts.isFile === false) {
    return {kind: 'unreadable', path, reason: 'not a regular file'};
  }
  if (facts.readable === false) {
    return {
      kind: 'unreadable',
      path,
      reason:
        'not readable by this app (a shell-owned adb push — re-run scripts/model.sh push)',
    };
  }
  const bytes = facts.bytes ?? 0;
  if (!(bytes > 0)) {
    return {kind: 'unreadable', path, reason: 'empty file'};
  }
  return {
    kind: 'present',
    path,
    bytes,
    lastModified: facts.lastModified ?? 0,
  };
}

/**
 * Maps the native `status()` result to file facts. The bridge reports the *chosen* path, whether
 * the file exists and (card A6) its byte size + readability; `isFile` is only known when the size
 * is: a present-but-directory path reports 0 bytes from Java's `length()` and lands in the
 * unreadable branch by size, which is the honest outcome.
 */
export function factsFromNativeStatus(status: {
  modelPresent: boolean;
  modelPath: string;
  modelBytes?: number;
  modelReadable?: boolean;
}): ModelFileFacts {
  return {
    path: status.modelPath,
    exists: status.modelPresent,
    isFile: status.modelPresent,
    readable: status.modelReadable,
    bytes: status.modelBytes,
  };
}

/** Present at the pinned size — the only state in which the embedder is expected to open. */
export function isModelReady(status: ModelStatus): boolean {
  return status.kind === 'present' && sizeMatches(status.bytes);
}

/** Unexpectedly long for a label, but keep it dependency-free (Hermes' Intl is not guaranteed). */
function groupThousands(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "484,622,336 B · 462.2 MiB" — same format as B6's ModelProbe.formatBytes. */
export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
  const mib = safe / (1024 * 1024);
  return `${groupThousands(safe)} B · ${mib.toFixed(1)} MiB`;
}

export function sizeMatches(bytes: number): boolean {
  return bytes === EXPECTED_MODEL_BYTES;
}

/** One line under the size: does it match the pinned bundle? */
export function sizeNote(bytes: number): string {
  return sizeMatches(bytes)
    ? 'matches the pinned bundle size'
    : `expected ${formatBytes(EXPECTED_MODEL_BYTES)} — wrong or truncated bundle`;
}

/** "EXPECTED e7a8a220… (not recomputed on the device)" — the sha is a label, not a live check. */
export function sha256Label(sha: string = EXPECTED_MODEL_SHA256): string {
  const short = sha.length > 12 ? `${sha.slice(0, 8)}…${sha.slice(-4)}` : sha;
  return `EXPECTED ${short} · not recomputed here`;
}

/** A one-line status for the UI; the missing branch starts with `E_NO_MODEL`. */
export function modelStatusLine(status: ModelStatus): string {
  switch (status.kind) {
    case 'present':
      return `present · ${formatBytes(status.bytes)} · ${sizeNote(status.bytes)}`;
    case 'missing':
      return `${E_NO_MODEL} · no bundle at ${status.path}`;
    case 'unreadable':
      return `unreadable · ${status.reason}`;
  }
}

/** The hint shown under E_NO_MODEL: the native push command when known, the generic text otherwise. */
export function pushHint(hint?: string | null): string {
  return hint !== null && hint !== undefined && hint.trim() !== ''
    ? hint
    : PUSH_HINT;
}
