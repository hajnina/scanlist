/**
 * localStorage persistence — one document per list.
 *
 * Key scheme (documented here once, mirrored in README.md):
 *   scanlist.v1.lists               -> index JSON: {version: 1, lists: [{id, title, itemCount, doneCount, importedAt, updatedAt}]}
 *   scanlist.v1.list.<id>           -> ONE LIST.md document, exactly what Export downloads (pretty JSON).
 *   scanlist.v1.corrupt             -> last corrupt payload we had to drop (raw text, forensic only).
 *
 * The stored document is the export document, so "import -> tick -> export" round-trips through
 * the same `parseList` on reload (card B2's Kotlin precedent: one file per list whose content is
 * the list). Ticks mutate the in-memory tree and rewrite only that list's document.
 *
 * Corruption policy (card C2): never white-screen. A bad index or a bad document is dropped,
 * its raw text is kept under the corrupt key, and the caller is told to fall back to the import
 * screen with an error toast.
 */

import { parseList } from "@scanlist/ts-core";
import type { ScanList } from "@scanlist/ts-core";

import { exportJson } from "./exportDoc";

/** The three Storage methods we need; tests pass a plain in-memory object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_KEYS = {
  index: "scanlist.v1.lists",
  docPrefix: "scanlist.v1.list.",
  corrupt: "scanlist.v1.corrupt",
} as const;

export interface ListIndexEntry {
  id: string;
  title: string;
  itemCount: number;
  doneCount: number;
  importedAt: string;
  updatedAt: string;
}

export interface LibraryIndex {
  version: 1;
  lists: ListIndexEntry[];
}

export interface ReadIndexResult {
  index: LibraryIndex;
  /** Non-null when something had to be dropped; show it as an error toast. */
  error: string | null;
}

export type ReadDocResult =
  | { ok: true; list: ScanList }
  | { ok: false; error: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function emptyIndex(): LibraryIndex {
  return { version: 1, lists: [] };
}

export function docKey(id: string): string {
  return `${STORAGE_KEYS.docPrefix}${id}`;
}

/** Ids are generated here, but an index could arrive corrupt: keep keys boring. */
export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function createListId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Best-effort forensic copy; a full quota must not stop the recovery path. */
function quarantine(storage: StorageLike, origin: string, raw: string): void {
  try {
    storage.setItem(
      STORAGE_KEYS.corrupt,
      JSON.stringify({ at: new Date().toISOString(), origin, raw: raw.slice(0, 200_000) }),
    );
  } catch {
    // ignore: recovery matters more than the forensic copy
  }
}

function isEntry(value: unknown): value is ListIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    isValidId(entry["id"]) &&
    typeof entry["title"] === "string" &&
    typeof entry["itemCount"] === "number" &&
    typeof entry["doneCount"] === "number" &&
    typeof entry["importedAt"] === "string" &&
    typeof entry["updatedAt"] === "string"
  );
}

/** Read + validate the index. Always returns a usable index; `error` says what was dropped. */
export function readIndex(storage: StorageLike): ReadIndexResult {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEYS.index);
  } catch {
    return { index: emptyIndex(), error: "Could not read saved lists from this browser." };
  }
  if (raw === null) return { index: emptyIndex(), error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(storage, STORAGE_KEYS.index, raw);
    storage.removeItem(STORAGE_KEYS.index);
    return {
      index: emptyIndex(),
      error: "Saved list index was not valid JSON — it was moved aside and the import screen is shown.",
    };
  }

  const candidate = parsed as { version?: unknown; lists?: unknown } | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.lists)
  ) {
    quarantine(storage, STORAGE_KEYS.index, raw);
    storage.removeItem(STORAGE_KEYS.index);
    return {
      index: emptyIndex(),
      error: "Saved list index had an unknown shape — it was moved aside and the import screen is shown.",
    };
  }

  const lists = candidate.lists.filter(isEntry);
  const dropped = candidate.lists.length - lists.length;
  if (dropped > 0) {
    quarantine(storage, STORAGE_KEYS.index, raw);
    const index = { version: 1 as const, lists };
    writeIndex(storage, index);
    return {
      index,
      error: `${dropped} saved list ${dropped === 1 ? "entry was" : "entries were"} corrupt and removed from the index.`,
    };
  }
  return { index: { version: 1, lists }, error: null };
}

/** Write the index; false when the browser refused (quota / private mode). */
export function writeIndex(storage: StorageLike, index: LibraryIndex): boolean {
  try {
    storage.setItem(STORAGE_KEYS.index, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

/** Read one list document and validate it with ts-core, exactly like an import. */
export function readDoc(storage: StorageLike, id: string): ReadDocResult {
  if (!isValidId(id)) return { ok: false, error: `Saved list id ${JSON.stringify(id)} is not valid.` };

  let raw: string | null;
  try {
    raw = storage.getItem(docKey(id));
  } catch {
    return { ok: false, error: "Could not read the saved list from this browser." };
  }
  if (raw === null) {
    return { ok: false, error: `Saved list ${id} is missing from this browser.` };
  }

  const result = parseList(raw);
  if (!result.ok) {
    quarantine(storage, docKey(id), raw);
    storage.removeItem(docKey(id));
    return {
      ok: false,
      error: `Saved list ${id} was corrupt (${result.errors[0] ?? "invalid JSON"}) — it was moved aside and the import screen is shown.`,
    };
  }
  return { ok: true, list: result.list };
}

/** Persist one list as its export document; false when storage is full/unavailable. */
export function writeDoc(storage: StorageLike, id: string, list: ScanList): boolean {
  try {
    storage.setItem(docKey(id), exportJson(list));
    return true;
  } catch {
    return false;
  }
}

/** In-memory Storage stand-in: tests, and the "private mode blocks localStorage" fallback. */
export function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** window.localStorage if it really works, else null (Safari private mode throws on write). */
export function browserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = "scanlist.v1.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export interface ResolvedStorage {
  storage: StorageLike;
  /**
   * Non-null when persistence is degraded (in-memory only); surfaced as the startup toast and a
   * persistent banner.
   */
  warning: string | null;
}

export function resolveStorage(): ResolvedStorage {
  const storage = browserStorage();
  if (storage) return { storage, warning: null };
  return {
    storage: memoryStorage(),
    warning: "This browser blocks localStorage — changes work for this session but will not survive a reload.",
  };
}
