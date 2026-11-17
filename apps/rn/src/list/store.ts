/**
 * Persistence (card A2), the RN counterpart of B2's `ListStore` / `ListRepository`.
 *
 * **The stored value is the export document.** Every list lives under one AsyncStorage key
 * (`scanlist/list/<id>`) whose value is exactly `encodeList(list)` — the LIST.md §7 JSON. That keeps
 * the B2 precedent (one file per list whose contents ARE the export) and makes "persist then
 * export" incapable of drifting, at the cost of storing `done` inside the document (which LIST.md
 * §3 says is the only mutable per-item state, so that is where it belongs).
 *
 * Storage is behind a tiny `KeyValueStore` interface so the whole persistence layer is testable in
 * Jest with an in-memory implementation; `asyncStorage.ts` is the only file that imports the native
 * module. Layout:
 *
 *   scanlist/list/<id>  -> the list document (identical to the exported JSON)
 *   scanlist/index      -> {"version":1,"entries":[{"id":"...","updatedAt":1712345678901}]}
 *
 * The index is a cache, never the source of truth: when it is missing, unreadable or points at a
 * list that no longer parses, `loadAll` rebuilds it from the keys (and drops the broken entries).
 * A corrupt document is skipped, never partially loaded (LIST.md §5: Ok or Error, no repair).
 */
import {flatten, parseList} from './core';
import {encodeList} from './encode';
import {toggleItem, withItemDone} from './edit';
import type {ScanList} from './core';

/** The slice of AsyncStorage this app needs; `MemoryKeyValueStore` is the test double. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

/** In-memory store for unit tests (and a last-resort fallback if the native module is missing). */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    Object.entries(initial).forEach(([key, value]) => this.map.set(key, value));
  }

  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }

  async getAllKeys(): Promise<readonly string[]> {
    return [...this.map.keys()];
  }

  /** Test helper: what is stored under one key (the raw document). */
  raw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

/** A list as loaded from / saved to storage. `id` is the key suffix, never part of the JSON. */
export interface StoredList {
  id: string;
  list: ScanList;
  /** Milliseconds, from the index (0 when unknown — e.g. right after a rebuild). */
  updatedAt: number;
}

/** How an import went (LIST.md §5: Ok or Error, no partial import). */
export type ImportResult =
  | {ok: true; stored: StoredList}
  | {ok: false; errors: string[]};

interface IndexEntry {
  id: string;
  updatedAt: number;
}

interface IndexDoc {
  version: number;
  entries: IndexEntry[];
}

const LIST_PREFIX = 'scanlist/list/';
const INDEX_KEY = 'scanlist/index';
const INDEX_VERSION = 1;

function isIndexDoc(value: unknown): value is IndexDoc {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<IndexDoc>;
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      entry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as IndexEntry).id === 'string' &&
        typeof (entry as IndexEntry).updatedAt === 'number',
    )
  );
}

/** Import / tick / export over a `KeyValueStore`. Plain TypeScript, no React, no native imports. */
export class ListRepository {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** All stored lists that still parse, newest first (the lists screen order). */
  async loadAll(): Promise<StoredList[]> {
    const entries = await this.readIndex();
    const out: StoredList[] = [];
    let dirty = entries === null;

    const candidates = entries ?? (await this.entriesFromKeys());
    for (const entry of candidates) {
      const stored = await this.get(entry.id);
      if (stored === null) {
        // Corrupt or deleted: drop it from the index instead of failing the whole screen.
        dirty = true;
        continue;
      }
      out.push(stored);
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (dirty) {
      await this.writeIndex(out.map(({id, updatedAt}) => ({id, updatedAt})));
    }
    return out;
  }

  /** One list, or `null` when it is missing or no longer parses (no partial loads). */
  async get(id: string): Promise<StoredList | null> {
    if (!isValidId(id)) {
      return null;
    }
    const text = await this.store.getItem(LIST_PREFIX + id);
    if (text === null) {
      return null;
    }
    const parsed = parseList(text);
    if (!parsed.ok) {
      return null;
    }
    const entries = (await this.readIndex()) ?? [];
    const updatedAt =
      entries.find(entry => entry.id === id)?.updatedAt ?? 0;
    return {id, list: parsed.list, updatedAt};
  }

  /**
   * Import a list from JSON text. A list may be imported any number of times (LIST.md §6: the app
   * does not deduplicate), so every successful import gets a fresh id.
   */
  async importText(text: string): Promise<ImportResult> {
    const parsed = parseList(text);
    if (!parsed.ok) {
      return {ok: false, errors: parsed.errors};
    }
    const id = await this.newId(parsed.list.title);
    return {ok: true, stored: await this.save(id, parsed.list)};
  }

  /** Toggle one item by its flattened id and persist. `null` when the list or id is unknown. */
  async toggle(listId: string, itemId: string): Promise<StoredList | null> {
    const stored = await this.get(listId);
    if (stored === null) {
      return null;
    }
    const updated = toggleItem(stored.list, itemId);
    if (updated === null) {
      return null;
    }
    return this.save(listId, updated);
  }

  /** Same as `toggle` but explicit, for a UI that knows the target state. */
  async setDone(
    listId: string,
    itemId: string,
    done: boolean,
  ): Promise<StoredList | null> {
    const stored = await this.get(listId);
    if (stored === null) {
      return null;
    }
    const updated = withItemDone(stored.list, itemId, done);
    if (updated === null) {
      return null;
    }
    return this.save(listId, updated);
  }

  /** Export the list as the normative JSON (LIST.md §7), including the `done` flags. */
  async exportJson(listId: string): Promise<string | null> {
    const stored = await this.get(listId);
    return stored === null ? null : encodeList(stored.list);
  }

  /** The stored value — the export document — for one list (used by the round-trip test). */
  async storedDocument(listId: string): Promise<string | null> {
    return this.store.getItem(LIST_PREFIX + listId);
  }

  async remove(listId: string): Promise<boolean> {
    if (!isValidId(listId) || (await this.get(listId)) === null) {
      return false;
    }
    await this.store.removeItem(LIST_PREFIX + listId);
    const entries = ((await this.readIndex()) ?? []).filter(
      entry => entry.id !== listId,
    );
    await this.writeIndex(entries);
    return true;
  }

  /** `{total, done}` across every stored list (the home screen hero numbers). */
  async totals(): Promise<{total: number; done: number}> {
    const lists = await this.loadAll();
    return lists.reduce(
      (sum, stored) => {
        const flat = flatten(stored.list);
        return {
          total: sum.total + flat.length,
          done: sum.done + flat.filter(item => item.done).length,
        };
      },
      {total: 0, done: 0},
    );
  }

  /** Write one list under `id`; returns the stored entry. The value is the export document. */
  async save(id: string, list: ScanList): Promise<StoredList> {
    if (!isValidId(id)) {
      throw new Error(`invalid list id: ${id}`);
    }
    const updatedAt = this.now();
    await this.store.setItem(LIST_PREFIX + id, encodeList(list));
    const entries = ((await this.readIndex()) ?? []).filter(
      entry => entry.id !== id,
    );
    await this.writeIndex([...entries, {id, updatedAt}]);
    return {id, list, updatedAt};
  }

  /** Slug of the title plus the first free numeric suffix ("weekly-shop", "weekly-shop-2", ...). */
  async newId(title: string): Promise<string> {
    const base =
      title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'list';
    const existing = new Set(await this.ids());
    if (!existing.has(base)) {
      return base;
    }
    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) {
      suffix += 1;
    }
    return `${base}-${suffix}`;
  }

  /** Every key suffix under `scanlist/list/` (stable, ascending). */
  async ids(): Promise<string[]> {
    return (await this.entriesFromKeys()).map(entry => entry.id);
  }

  private async entriesFromKeys(): Promise<IndexEntry[]> {
    const keys = await this.store.getAllKeys();
    return keys
      .filter(key => key.startsWith(LIST_PREFIX))
      .map(key => ({id: key.slice(LIST_PREFIX.length), updatedAt: 0}))
      .filter(entry => isValidId(entry.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The cached index, or `null` when it is missing or unreadable (then it gets rebuilt). */
  private async readIndex(): Promise<IndexEntry[] | null> {
    const text = await this.store.getItem(INDEX_KEY);
    if (text === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isIndexDoc(parsed) ? parsed.entries : null;
    } catch {
      return null;
    }
  }

  private async writeIndex(entries: IndexEntry[]): Promise<void> {
    const doc: IndexDoc = {version: INDEX_VERSION, entries};
    await this.store.setItem(INDEX_KEY, JSON.stringify(doc));
  }
}

/** True for ids this repository wrote (slug/dash/number) — never a path or key traversal. */
export function isValidId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[a-z0-9_-]+$/.test(id);
}

/** Storage key of one list (shown in the export card as the on-device location). */
export function storageKeyFor(id: string): string {
  return LIST_PREFIX + id;
}

/** Storage key of the index (exposed for tests and diagnostics). */
export const INDEX_STORAGE_KEY = INDEX_KEY;
