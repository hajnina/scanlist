/**
 * localStorage persistence + corrupt-data recovery (card C2).
 *
 * The contract: the stored document IS the export document, so reload re-imports it with the same
 * `parseList`; and a corrupt index/document must never throw into the UI — it is moved aside, the
 * caller gets an error string (shown as a toast) and the import screen is what the user sees.
 */

import { describe, expect, it } from "vitest";
import { flatten, parseList } from "@scanlist/ts-core";
import type { ScanList } from "@scanlist/ts-core";

import {
  STORAGE_KEYS,
  createListId,
  docKey,
  emptyIndex,
  isValidId,
  memoryStorage,
  readDoc,
  readIndex,
  sweepOrphanDocs,
  writeDoc,
  writeIndex,
} from "../src/core/storage";
import type { LibraryIndex, ListIndexEntry, StorageLike } from "../src/core/storage";
import { samples } from "./samples";

const sample = samples.find((entry) => entry.name === "van-weekly");
if (sample === undefined) throw new Error("van-weekly sample missing");
const sampleText: string = sample.text;

function parsedSample(): ScanList {
  const parsed = parseList(sampleText);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.list;
}

function entry(overrides: Partial<ListIndexEntry> = {}): ListIndexEntry {
  return {
    id: "list-1",
    title: "Van weekly shop",
    itemCount: 10,
    doneCount: 0,
    importedAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    ...overrides,
  };
}

function throwingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
}

describe("index", () => {
  it("starts empty on a fresh browser", () => {
    const storage = memoryStorage();
    expect(readIndex(storage)).toEqual({ index: emptyIndex(), error: null });
  });

  it("round-trips a written index", () => {
    const storage = memoryStorage();
    const index: LibraryIndex = { version: 1, lists: [entry()] };
    expect(writeIndex(storage, index)).toBe(true);
    expect(readIndex(storage).index).toEqual(index);
  });

  it("moves a corrupt index aside instead of throwing", () => {
    const storage = memoryStorage({ [STORAGE_KEYS.index]: "{not json" });
    const result = readIndex(storage);

    expect(result.index.lists).toEqual([]);
    expect(result.error).toContain("not valid JSON");
    expect(storage.getItem(STORAGE_KEYS.index)).toBeNull();

    const quarantined = JSON.parse(storage.getItem(STORAGE_KEYS.corrupt) ?? "{}") as {
      origin?: string;
      raw?: string;
    };
    expect(quarantined.origin).toBe(STORAGE_KEYS.index);
    expect(quarantined.raw).toBe("{not json");
  });

  it("rejects an unknown index shape", () => {
    const storage = memoryStorage({
      [STORAGE_KEYS.index]: JSON.stringify({ version: 99, lists: [] }),
    });
    const result = readIndex(storage);
    expect(result.index.lists).toEqual([]);
    expect(result.error).toContain("unknown shape");
  });

  it("drops only the invalid entries and rewrites the index", () => {
    const storage = memoryStorage({
      [STORAGE_KEYS.index]: JSON.stringify({
        version: 1,
        lists: [entry(), { id: "../etc/passwd", title: "bad", itemCount: 1, doneCount: 0, importedAt: "", updatedAt: "" }, entry({ id: "list-2", title: "Corner shop" })],
      }),
    });
    const result = readIndex(storage);

    expect(result.index.lists.map((list) => list.id)).toEqual(["list-1", "list-2"]);
    expect(result.error).toContain("1 saved list entry");
    // The corrected index was persisted, so the next read is clean.
    expect(readIndex(storage)).toEqual({ index: result.index, error: null });
  });
});

describe("documents — the persisted format is the export document", () => {
  it("stores and reloads a list through parseList with identical flattening", () => {
    const storage = memoryStorage();
    const list = parsedSample();
    expect(writeDoc(storage, "list-1", list)).toBe(true);

    const result = readDoc(storage, "list-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flatten(result.list)).toEqual(flatten(list));
    // The stored bytes are exactly what Export downloads.
    expect(storage.getItem(docKey("list-1"))).toContain('"title": "Van weekly shop"');
  });

  it("reports a missing document", () => {
    const result = readDoc(memoryStorage(), "list-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing");
  });

  it("recovers from a corrupt document by removing it and reporting why", () => {
    const storage = memoryStorage({ [docKey("list-1")]: '{"title": "Broken"' });
    const result = readDoc(storage, "list-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("corrupt");
    expect(storage.getItem(docKey("list-1"))).toBeNull();
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.corrupt) ?? "{}")).toMatchObject({
      origin: docKey("list-1"),
    });
  });

  it("recovers from a document that is JSON but not a list", () => {
    const storage = memoryStorage({
      [docKey("list-1")]: JSON.stringify({ title: "x", sections: {} }),
    });
    const result = readDoc(storage, "list-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("/sections");
  });

  it("refuses ids that are not safe storage keys", () => {
    expect(isValidId("list-1")).toBe(true);
    expect(isValidId("../x")).toBe(false);
    expect(isValidId("")).toBe(false);
    expect(readDoc(memoryStorage(), "../../x").ok).toBe(false);
  });
});

describe("orphaned documents — the load-time sweep (C2 follow-up)", () => {
  /** A library of `ids`, each with its stored document; returns the storage. */
  function seeded(ids: string[]): StorageLike {
    const storage = memoryStorage();
    const list = parsedSample();
    for (const id of ids) writeDoc(storage, id, list);
    writeIndex(storage, { version: 1, lists: ids.map((id) => entry({ id })) });
    return storage;
  }

  it("keeps every document a live list references", () => {
    const storage = seeded(["list-1", "list-2"]);

    expect(sweepOrphanDocs(storage, { version: 1, lists: [entry(), entry({ id: "list-2" })] })).toEqual(
      [],
    );
    expect(storage.getItem(docKey("list-1"))).not.toBeNull();
    expect(storage.getItem(docKey("list-2"))).not.toBeNull();

    // The real entry point (readIndex) sweeps too, and leaves live documents alone.
    expect(readIndex(storage)).toEqual({ index: { version: 1, lists: [entry(), entry({ id: "list-2" })] }, error: null });
    expect(storage.getItem(docKey("list-1"))).not.toBeNull();
  });

  it("removes documents a list deletion orphaned", () => {
    const storage = seeded(["list-1", "list-2"]);

    // Delete list-2 the way the app would: rewrite the index without it (its document stays).
    writeIndex(storage, { version: 1, lists: [entry()] });
    const result = readIndex(storage);

    expect(result.error).toBeNull();
    expect(result.index.lists.map((list) => list.id)).toEqual(["list-1"]);
    expect(storage.getItem(docKey("list-2"))).toBeNull();
    expect(storage.getItem(docKey("list-1"))).not.toBeNull();
  });

  it("sweeps a document created but never attached (failed import)", () => {
    const storage = seeded([]);
    // Import order is writeDoc -> writeIndex; if the second write fails the document is stranded.
    writeDoc(storage, "never-indexed", parsedSample());
    expect(storage.getItem(docKey("never-indexed"))).not.toBeNull();

    // Through the real entry point: a load finds an empty library and one unreferenced document.
    expect(readIndex(storage)).toEqual({ index: emptyIndex(), error: null });
    expect(storage.getItem(docKey("never-indexed"))).toBeNull();
  });

  it("is idempotent: a second sweep is a no-op", () => {
    const storage = seeded(["list-1"]);
    writeDoc(storage, "orphan", parsedSample());

    const first = sweepOrphanDocs(storage, { version: 1, lists: [entry()] });
    const second = sweepOrphanDocs(storage, { version: 1, lists: [entry()] });

    expect(first).toEqual([docKey("orphan")]);
    expect(second).toEqual([]);
    expect(storage.getItem(docKey("list-1"))).not.toBeNull();
  });

  it("never touches anything that is not a list document", () => {
    const storage = seeded(["list-1"]);
    storage.setItem("someone.elses.key", "keep me");
    storage.setItem(STORAGE_KEYS.corrupt, "forensics");

    sweepOrphanDocs(storage, { version: 1, lists: [entry()] });

    expect(storage.getItem("someone.elses.key")).toBe("keep me");
    expect(storage.getItem(STORAGE_KEYS.corrupt)).toBe("forensics");
    expect(storage.getItem(STORAGE_KEYS.index)).not.toBeNull();
  });

  it("does not sweep when the index itself was dropped (its emptiness proves nothing)", () => {
    const storage = seeded(["list-1"]);
    storage.setItem(STORAGE_KEYS.index, "{not json");

    // A corrupt index is quarantined for manual recovery; deleting every document would make that
    // recovery impossible, so readIndex skips the sweep on this path.
    expect(readIndex(storage).error).toContain("not valid JSON");
    expect(storage.getItem(docKey("list-1"))).not.toBeNull();
  });

  it("declines to sweep storage it cannot enumerate", () => {
    const storage = seeded(["list-1"]);
    const threeMethods: StorageLike = {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };

    expect(sweepOrphanDocs(threeMethods, emptyIndex())).toEqual([]);
    expect(storage.getItem(docKey("list-1"))).not.toBeNull();
  });
});

describe("degraded storage (private mode / quota)", () => {
  it("never throws when the browser refuses to read or write", () => {
    const storage = throwingStorage();
    expect(readIndex(storage).index.lists).toEqual([]);
    expect(readIndex(storage).error).not.toBeNull();
    expect(readDoc(storage, "list-1").ok).toBe(false);
    expect(writeDoc(storage, "list-1", parsedSample())).toBe(false);
    expect(writeIndex(storage, emptyIndex())).toBe(false);
  });
});

describe("ids + memory storage", () => {
  it("generates url-safe, unique ids", () => {
    const ids = new Set(Array.from({ length: 25 }, () => createListId()));
    expect(ids.size).toBe(25);
    for (const id of ids) expect(isValidId(id)).toBe(true);
  });

  it("implements the three Storage methods", () => {
    const storage = memoryStorage({ a: "1" });
    expect(storage.getItem("a")).toBe("1");
    storage.setItem("b", "2");
    expect(storage.getItem("b")).toBe("2");
    storage.removeItem("a");
    expect(storage.getItem("a")).toBeNull();
  });
});
