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
 *
 * Orphan policy (C2 follow-up): the index is the only route to a document, so documents the index
 * does not reference are deleted on load (`sweepOrphanDocs` via `readIndex`) — except when the
 * index itself was dropped, where deleting them would destroy recoverable data.
 */

import { parseList } from "@scanlist/ts-core";
import type { ScanList } from "@scanlist/ts-core";

import { exportJson } from "./exportDoc";

/** The three Storage methods we need; tests pass a plain in-memory object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /**
   * Key enumeration, exactly the Web Storage shape (`Storage.length` / `Storage.key(i)`), and
   * optional because a three-method stand-in is still a valid store. Without it the orphan sweep
   * (below) declines to guess which keys exist rather than skipping silently by accident.
   */
  readonly length?: number;
  key?(index: number): string | null;
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

/** Internal: the index plus whether its emptiness is evidence about the stored documents. */
interface IndexRead extends ReadIndexResult {
  /**
   * False when the index itself was lost/unreadable. Then "zero entries" says nothing about the
   * documents on disk, so the orphan sweep must not treat every document as garbage — the raw
   * index is still in the quarantine key, so those documents remain recoverable by hand.
   */
  trustworthy: boolean;
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
function readIndexOnly(storage: StorageLike): IndexRead {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEYS.index);
  } catch {
    return {
      index: emptyIndex(),
      error: "Could not read saved lists from this browser.",
      trustworthy: false,
    };
  }
  if (raw === null) return { index: emptyIndex(), error: null, trustworthy: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(storage, STORAGE_KEYS.index, raw);
    storage.removeItem(STORAGE_KEYS.index);
    return {
      index: emptyIndex(),
      error: "Saved list index was not valid JSON — it was moved aside and the import screen is shown.",
      trustworthy: false,
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
      trustworthy: false,
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
      trustworthy: true,
    };
  }
  return { index: { version: 1, lists }, error: null, trustworthy: true };
}

/**
 * Read the index, then sweep documents that no index entry references (C2 follow-up: the review
 * found orphaned documents accumulating until the quota filled up).
 *
 * Where orphans come from: an import writes the document first and the index second, so a failed
 * second write (quota, private mode, a crash or a closed tab between the two) leaves a document
 * nothing points at; dropping a corrupt index entry or removing a corrupt document does the same.
 * Nothing else can reach such a document — the index is the only way in — so it is pure waste, and
 * at 5 MiB per list a handful of them can evict live lists.
 *
 * Trigger: storage load (here), not list deletion. There is no delete-list UI yet, the index is
 * rewritten on every tick, and every orphan source above is only observable once the index has been
 * read — one call site covers all of them. The cost is one key enumeration per page load.
 *
 * Trigger is `readIndex` and not `resolveStorage`: the sweep needs the index to know what is live,
 * and `resolveStorage` runs before any list is read. It is deliberately *not* run when the index
 * itself was dropped (see `IndexRead.trustworthy`).
 */
export function sweepOrphanDocs(storage: StorageLike, index: LibraryIndex): string[] {
  const live = new Set<string>();
  for (const entry of index.lists) live.add(docKey(entry.id));

  const length = storage.length;
  const keyAt = storage.key;
  if (typeof length !== "number" || typeof keyAt !== "function") return [];

  // Snapshot the doomed keys first: removing keys while walking a real Storage shifts every later
  // index. Enumeration order is unspecified by Web Storage, so nothing here depends on it.
  const doomed: string[] = [];
  for (let position = 0; position < length; position += 1) {
    let key: string | null;
    try {
      key = keyAt.call(storage, position);
    } catch {
      return []; // storage became unreadable mid-scan: leave it for the next load
    }
    if (key === null || !key.startsWith(STORAGE_KEYS.docPrefix) || live.has(key)) continue;
    doomed.push(key);
  }

  const removed: string[] = [];
  for (const key of doomed) {
    try {
      storage.removeItem(key);
      removed.push(key);
    } catch {
      // quota/blocked storage: the document stays, and the next load tries again
    }
  }
  return removed;
}

/** `readIndex` + the orphan sweep above: the single entry point the app uses on startup. */
export function readIndex(storage: StorageLike): ReadIndexResult {
  const result = readIndexOnly(storage);
  if (result.trustworthy) sweepOrphanDocs(storage, result.index);
  return { index: result.index, error: result.error };
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
    // Enumeration so the orphan sweep works here exactly as it does on a real localStorage.
    get length() {
      return data.size;
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
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
