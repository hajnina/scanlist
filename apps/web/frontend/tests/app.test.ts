// @vitest-environment happy-dom
/**
 * App-level behaviour: mount the real `<App/>` and drive it the way a user does.
 *
 * Why this file exists (card C2, "corrupt persisted data -> import screen with an error toast,
 * never a white screen"): core/storage.ts proves the *policy*, but only a mounted app proves the
 * screen actually recovers, that ticking reaches localStorage, that a reload re-imports the stored
 * document, and that the demo/paste/URL transports all land on the list screen.
 *
 * happy-dom (not jsdom) because @material/web is Lit-based: Lit needs working custom elements and
 * shadow DOM, and the assertions here are light-DOM text + dispatched DOM events — i.e. exactly
 * what a mouse and keyboard produce. Everything cheaper to test without a DOM lives in
 * tests/{importer,storage,export,display,golden}.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { flatten, parseList } from "@scanlist/ts-core";

import { App, scanTarget } from "../src/app";
import { STORAGE_KEYS, docKey } from "../src/core/storage";
import type { ListIndexEntry } from "../src/core/storage";
import { URL_IMPORT_TIMEOUT_MS } from "../src/core/importer";
import { exportJson } from "../src/core/exportDoc";
import { samples } from "./samples";

const vanWeekly = samples.find((sample) => sample.name === "van-weekly");
if (vanWeekly === undefined) throw new Error("van-weekly sample missing");

const marketRun = samples.find((sample) => sample.name === "string-amounts");
if (marketRun === undefined) throw new Error("string-amounts sample missing");

/**
 * happy-dom has no `ElementInternals`, and @material/web's form-associated elements call
 * `attachInternals()` unconditionally from the Lit constructor (labs/behaviors/element-internals.js).
 * The shim is the minimum surface those components touch — enough for the real buttons, checkbox and
 * text field to construct and render; nothing here is asserted.
 */
function installElementInternalsShim(): void {
  const proto = HTMLElement.prototype as unknown as {
    attachInternals?: () => ElementInternals;
  };
  if (typeof proto.attachInternals === "function") return;

  const states = { add() {}, delete() {}, has: () => false, clear() {}, forEach() {} };
  proto.attachInternals = function shimAttachInternals(): ElementInternals {
    return {
      form: null,
      labels: [],
      states,
      willValidate: false,
      validity: { valid: true },
      validationMessage: "",
      setFormValue() {},
      setValidity() {},
      checkValidity: () => true,
      reportValidity: () => true,
    } as unknown as ElementInternals;
  } as () => ElementInternals;
}

installElementInternalsShim();

let root: HTMLDivElement | null = null;

function mount(): void {
  root = document.createElement("div");
  document.body.append(root);
  render(h(App, {}), root);
}

function unmount(): void {
  if (root !== null) render(null, root);
  root = null;
}

/**
 * Preact flushes state in a microtask but defers `useEffect` to the next frame, so one macrotask is
 * not always enough (the startup toasts are effects). Two turns of the event loop is plenty and
 * still far below the 4-8 s toast lifetime.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function screenText(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function exists(selector: string): Element | null {
  return document.querySelector(selector);
}

function all(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

/** First element matching `selector` whose text contains `needle`; a missing one fails loudly. */
function find(selector: string, needle: string): HTMLElement {
  const match = all(selector).find((element) => (element.textContent ?? "").includes(needle));
  if (match === undefined) {
    throw new Error(
      `no ${selector} containing ${JSON.stringify(needle)} in: ${screenText().slice(0, 300)}`,
    );
  }
  return match;
}

function click(selector: string, needle: string): void {
  find(selector, needle).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeInto(selector: string, value: string): void {
  const field = exists(selector) as (HTMLElement & { value: string }) | null;
  if (field === null) throw new Error(`no ${selector} on screen`);
  field.value = value;
}

function readIndex(): { lists: Array<Record<string, unknown>> } {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.index) ?? "{}") as {
    lists: Array<Record<string, unknown>>;
  };
}

interface SeedList {
  id: string;
  text: string;
  updatedAt: string;
}

/**
 * Seed a library the way imports + reloads leave it: one stored export document per list, plus the
 * metadata index. Index order is taken as given (the app prepends new imports, so index[0] is the
 * most recently *imported* list — deliberately independent of `updatedAt` in these fixtures).
 */
function seedLibrary(lists: SeedList[]): void {
  const entries: ListIndexEntry[] = lists.map(({ id, text, updatedAt }) => {
    const parsed = parseList(text);
    if (!parsed.ok) throw new Error(`fixture ${id} does not parse`);
    localStorage.setItem(docKey(id), exportJson(parsed.list));
    return {
      id,
      title: parsed.list.title,
      itemCount: flatten(parsed.list).length,
      doneCount: 0,
      importedAt: updatedAt,
      updatedAt,
    };
  });
  localStorage.setItem(STORAGE_KEYS.index, JSON.stringify({ version: 1, lists: entries }));
}

const marketRunTitle = "Market run (free-text amounts)";

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fresh start", () => {
  it("shows the import screen and an enabled Scan entry that asks for a list first", async () => {
    mount();
    await flush();

    expect(screenText()).toContain("IMPORT A LIST");
    expect(screenText()).toContain("SAVED LISTS");
    expect(screenText()).toContain("Nothing imported yet");

    // Card C5 replaced the placeholder with the real entry: with no lists it is honest, not dead.
    const scan = find("button.nav-item", "Scan") as HTMLButtonElement;
    expect(scan.disabled).toBe(false);
    expect(scan.textContent).not.toContain("C5");

    scan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(screenText()).toContain("NO LIST OPEN");

    click("md-filled-button", "Back to lists");
    await flush();
    expect(screenText()).toContain("IMPORT A LIST");
    expect(localStorage.getItem(STORAGE_KEYS.index)).toBeNull();
  });
});

describe("Scan opens the most recently updated list (C5 review bug 1)", () => {
  it("picks max(updatedAt), not index order", async () => {
    // Index order deliberately disagrees with recency: the newest import is the stalest list.
    seedLibrary([
      { id: "list-newer-import", text: vanWeekly.text, updatedAt: "2026-11-16T09:00:00.000Z" },
      { id: "list-older-import", text: marketRun.text, updatedAt: "2026-11-17T09:00:00.000Z" },
    ]);

    mount();
    await flush();
    click("button.nav-item", "Scan");
    await flush();

    expect(screenText()).toContain("MAGIC SCAN");
    expect(screenText()).toContain(marketRunTitle);
    expect(screenText()).not.toContain("Van weekly shop");
  });

  it("switches to a list as soon as a tick bumps its updatedAt", async () => {
    seedLibrary([
      { id: "list-a", text: marketRun.text, updatedAt: "2026-11-16T09:00:00.000Z" },
      { id: "list-b", text: vanWeekly.text, updatedAt: "2026-11-17T09:30:00.000Z" },
    ]);

    mount();
    await flush();

    // B is the most recent at first.
    click("button.nav-item", "Scan");
    await flush();
    expect(screenText()).toContain("Van weekly shop");

    // Back to the lists, open A, tick one item: `toggleItem` stamps A with updatedAt = now.
    click("button", "Lists");
    await flush();
    click("button.library-button", marketRunTitle);
    await flush();
    const box = exists("md-checkbox");
    expect(box, "list A has a checkbox").not.toBeNull();
    box?.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    click("button", "Lists");
    await flush();
    click("button.nav-item", "Scan");
    await flush();

    expect(screenText()).toContain(marketRunTitle);
    expect(screenText()).not.toContain("Van weekly shop");
  });

  it("breaks updatedAt ties deterministically (index order)", () => {
    const tie: ListIndexEntry[] = [
      {
        id: "first-in-index",
        title: "First",
        itemCount: 1,
        doneCount: 0,
        importedAt: "2026-11-17T09:00:00.000Z",
        updatedAt: "2026-11-17T09:00:00.000Z",
      },
      {
        id: "second-in-index",
        title: "Second",
        itemCount: 1,
        doneCount: 0,
        importedAt: "2026-11-17T09:00:00.000Z",
        updatedAt: "2026-11-17T09:00:00.000Z",
      },
    ];

    // Equal timestamps keep stored index order: the first entry (the newest import) wins.
    expect(scanTarget(tie)?.id).toBe("first-in-index");
    expect(scanTarget([...tie].reverse())?.id).toBe("second-in-index");
    expect(scanTarget([])).toBeNull();
  });
});

describe("import -> tick -> persist -> reload", () => {
  it("stores the export document, survives a remount and keeps the tick", async () => {
    mount();
    await flush();

    click("md-text-button", "Load the demo list");
    await flush();

    // Landed on the list screen with the nested document rendered.
    expect(screenText()).toContain("PROGRESS");
    expect(screenText()).toContain("Van weekly shop");
    expect(screenText()).toContain("Fresh");
    expect(screenText()).toContain("Dairy");

    const index = readIndex();
    expect(index.lists).toHaveLength(1);
    const entry = index.lists[0] as { id: string; itemCount: number; doneCount: number };
    expect(entry.itemCount).toBe(vanWeekly.itemCount);
    expect(entry.doneCount).toBe(0);

    // Persisted bytes are exactly the export document of the parsed list (B2 precedent: the stored
    // file *is* the list, so reload == re-import).
    const parsed = parseList(vanWeekly.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(localStorage.getItem(docKey(entry.id))).toBe(exportJson(parsed.list));

    // Tick the first item through the real checkbox: the host element bubbles `change`.
    const box = exists("md-checkbox");
    expect(box, "the list screen has item checkboxes").not.toBeNull();
    box?.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(document.querySelectorAll(".item.is-done")).toHaveLength(1);
    expect(screenText()).toContain(`1 of ${vanWeekly.itemCount} done`);

    const storedDoc = parseList(localStorage.getItem(docKey(entry.id)) ?? "");
    expect(storedDoc.ok).toBe(true);
    if (!storedDoc.ok) return;
    expect(flatten(storedDoc.list).filter((item) => item.done)).toHaveLength(1);
    expect((readIndex().lists[0] as { doneCount: number }).doneCount).toBe(1);

    // Remount == reload: the library comes back from localStorage and the tick is still there.
    unmount();
    mount();
    await flush();
    expect(screenText()).toContain("SAVED LISTS");
    expect(screenText()).toContain("Van weekly shop");
    expect(screenText()).toContain(`${vanWeekly.itemCount - 1} left`);

    click("button.library-button", "Van weekly shop");
    await flush();
    expect(screenText()).toContain(`1 of ${vanWeekly.itemCount} done`);
    expect(document.querySelectorAll(".item.is-done")).toHaveLength(1);
  });

  it("exports the document as a download named after the title", async () => {
    mount();
    await flush();
    click("md-text-button", "Load the demo list");
    await flush();

    // Capture the synthetic <a download> the app clicks instead of letting happy-dom navigate.
    const anchors: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchors.push({ href: this.href, download: this.download });
    });

    click("md-filled-button", "Export JSON");
    await flush();

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.download).toBe("van-weekly-shop.json");
    expect(anchors[0]?.href.startsWith("blob:")).toBe(true);
    expect(screenText()).toContain("Exported van-weekly-shop.json");
  });
});

describe("import transports", () => {
  it("rejects an invalid paste with the ts-core RFC 6901 pointer inline", async () => {
    mount();
    await flush();

    click("button.chip", "Paste");
    await flush();
    typeInto("textarea.paste-area", '{"title": "x", "sections": [{"name": "A", "items": [{"name": 3}]}]}');

    click("md-filled-button", "Import pasted JSON");
    await flush();

    expect(exists(".import-errors")).not.toBeNull();
    expect(screenText()).toContain("/sections/0/items/0/name");
    expect(screenText()).toContain("nothing was saved");
    expect(localStorage.getItem(STORAGE_KEYS.index)).toBeNull();
  });

  it("fetches a URL through window.fetch and opens the list", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(vanWeekly.text, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await flush();
    click("button.chip", "URL");
    await flush();
    typeInto("md-outlined-text-field", "/samples/van-weekly.json");

    click("md-outlined-button", "Fetch and import");
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screenText()).toContain("Van weekly shop");
    expect(readIndex().lists).toHaveLength(1);
  });

  it("surfaces a failed fetch as a toast instead of importing half a list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );

    mount();
    await flush();
    click("button.chip", "URL");
    await flush();
    typeInto("md-outlined-text-field", "https://example.test/list.json");

    click("md-outlined-button", "Fetch and import");
    await flush();
    await flush();

    expect(screenText()).toContain("HTTP 404");
    expect(screenText()).toContain("Import failed");
    expect(localStorage.getItem(STORAGE_KEYS.index)).toBeNull();
  });

  /**
   * C2 follow-up: a hung URL used to block the import forever ("Fetching…" spinner never stopped).
   * This drives the real UI path — ImportPanel -> importFromUrl -> app.applyOutcome -> inline error
   * list + toast — so the classified timeout error is proven to reach the existing error surface.
   */
  it("aborts a hung URL import at 10 s and shows the classified timeout error", async () => {
    mount();
    await flush();
    click("button.chip", "URL");
    await flush();
    typeInto("md-outlined-text-field", "https://example.test/hung.json");

    // Fake only the timer the timeout uses: mounting/effects need happy-dom's real scheduling
    // (fake rAF leaks past restore into later tests' `useEffect` toasts).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hangingFetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );
      vi.stubGlobal("fetch", hangingFetch);

      click("md-outlined-button", "Fetch and import");
      await vi.advanceTimersByTimeAsync(URL_IMPORT_TIMEOUT_MS - 1);
      // Still waiting: no error surface one millisecond before the cap.
      expect(exists(".import-errors")).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(hangingFetch).toHaveBeenCalledTimes(1);
      expect(exists(".import-errors")).not.toBeNull();
      expect(screenText()).toContain("timed out");
      expect(screenText()).toContain("Import failed");
      // Nothing was half-imported.
      expect(localStorage.getItem(STORAGE_KEYS.index)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("corrupt persisted data never white-screens", () => {
  const entry = {
    id: "aaaabbbbcccc",
    title: "Broken list",
    itemCount: 2,
    doneCount: 0,
    importedAt: "2026-11-17T09:00:00.000Z",
    updatedAt: "2026-11-17T09:00:00.000Z",
  };

  it("drops a corrupt document, quarantines it and returns to the import screen with a toast", async () => {
    localStorage.setItem(STORAGE_KEYS.index, JSON.stringify({ version: 1, lists: [entry] }));
    localStorage.setItem(docKey(entry.id), '{"title": "Broken list", "sections": [}');

    mount();
    await flush();
    // The index itself is fine, so the row is offered first.
    expect(screenText()).toContain("Broken list");

    click("button.library-button", "Broken list");
    await flush();

    // Import screen, an error toast, no half-open list and no blank page.
    expect(screenText()).toContain("IMPORT A LIST");
    expect(exists(".toast-error")).not.toBeNull();
    expect(screenText()).toContain("corrupt");
    expect(exists(".progress-card")).toBeNull();
    expect(readIndex().lists).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEYS.corrupt) ?? "").toContain("sections");
  });

  it("recovers from a corrupt index with an error toast on the import screen", async () => {
    localStorage.setItem(STORAGE_KEYS.index, "{not json");

    mount();
    await flush();

    expect(screenText()).toContain("IMPORT A LIST");
    expect(exists(".toast-error")).not.toBeNull();
    expect(screenText()).toContain("not valid JSON");
    expect(localStorage.getItem(STORAGE_KEYS.corrupt) ?? "").toContain("not json");
    expect(localStorage.getItem(STORAGE_KEYS.index)).toBeNull();
  });

  it("keeps the good entries when only part of the index is corrupt", async () => {
    localStorage.setItem(
      STORAGE_KEYS.index,
      JSON.stringify({ version: 1, lists: [entry, { id: "not a valid id!", title: "Junk" }, null] }),
    );

    mount();
    await flush();

    expect(screenText()).toContain("Broken list");
    expect(screenText()).not.toContain("Junk");
    expect(screenText()).toContain("2 saved list entries were corrupt");
    expect(readIndex().lists).toHaveLength(1);
  });

  it("still works, with a warning, when localStorage throws on every write", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
      clear: () => undefined,
    });

    mount();
    await flush();
    // Degraded mode is announced...
    expect(screenText()).toContain("IMPORT A LIST");
    expect(screenText()).toContain("blocks localStorage");

    // ...by a persistent banner, not only the 8 s toast (C5 review nit a).
    const banner = exists(".degraded-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("Storage off");

    // Dismissing the toast must not take the banner with it.
    click(".toast-close", "×");
    await flush();
    expect(exists(".toast-error")).toBeNull();
    expect(exists(".degraded-banner")).not.toBeNull();
    expect(screenText()).toContain("Storage off");

    // ...and the app is still usable for this session.
    click("md-text-button", "Load the demo list");
    await flush();
    expect(screenText()).toContain("Van weekly shop");
    expect(screenText()).toContain("PROGRESS");
    // In-memory fallback: the import itself succeeds, and the warning above is the honest part.
    expect(screenText()).toContain("Imported “Van weekly shop”");
  });
});
