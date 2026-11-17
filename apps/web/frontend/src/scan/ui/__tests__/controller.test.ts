/**
 * Card C5 — the rank WIRING, through the real controller: synthetic ScanSignal/FrameEmbedResult
 * sequences → pool → ts-core `decideTop()` → ScanUiState.
 *
 * The heart of the card. No camera, no DOM, no network: a synchronous fake `EmbedPort` (vectors keyed
 * by raw text) and a fake `OffPort` stand in for the server, exactly the seam C4's tests use.
 */

import { describe, expect, it } from "vitest";
import { docText, flatten } from "@scanlist/ts-core";
import type { FlattenedItem, ScanList } from "@scanlist/ts-core";

import { createScanController } from "../controller";
import type { ScanController, ScanUiState } from "../controller";
import type { Clock } from "../../sources/clock";
import type { FrameEmbedResult, ScanSignal } from "../../sources/types";
import type { OffPort, OffResolution } from "../offClient";
import type { EmbedPort, EmbedResolution } from "../textEmbedder";
import { vec } from "./helpers";

/**
 * One OCR line per item, each line a little less similar to its own target than the previous one
 * (`1 - i*0.06` on its own axis, the remainder on a shared noise axis 255). Real OCR lines are not
 * exact item matches, and the ranker must see a genuine margin between them.
 */
function gradedLineQueries(count: number): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let index = 1; index <= count; index += 1) {
    const similarity = Math.max(0.05, 1 - index * 0.06);
    const rest = Math.sqrt(Math.max(0, 1 - similarity * similarity));
    map.set(`line ${index}`, vec({ [index]: similarity, 255: rest }));
  }
  return map;
}

function makeList(names: string[]): ScanList {
  return { title: "Shop", sections: [{ name: "Shop", items: names.map((name) => ({ name })) }] };
}

function docMap(flat: FlattenedItem[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  flat.forEach((item, index) => map.set(docText(item), vec({ [index]: 1 })));
  return map;
}

interface FakeEmbed {
  port: EmbedPort;
  docs: Map<string, number[]>;
  queries: Map<string, number[]>;
  requestedDocs: string[];
  requestedQueries: string[];
}

function fakeEmbed(docs = new Map<string, number[]>(), queries = new Map<string, number[]>()): FakeEmbed {
  const requestedDocs: string[] = [];
  const requestedQueries: string[] = [];
  const resolve = (
    texts: readonly string[],
    cache: Map<string, number[]>,
    requested: string[],
  ): EmbedResolution => {
    const vectors = new Map<string, number[]>();
    const pending: string[] = [];
    for (const text of texts) {
      const found = cache.get(text);
      if (found !== undefined) vectors.set(text, found);
      else {
        pending.push(text);
        if (!requested.includes(text)) requested.push(text);
      }
    }
    return { vectors, pending, failed: [] };
  };
  return {
    port: {
      resolveDocs: (texts) => resolve(texts, docs, requestedDocs),
      resolveQueries: (texts) => resolve(texts, queries, requestedQueries),
      lastError: () => null,
      dispose: () => undefined,
    },
    docs,
    queries,
    requestedDocs,
    requestedQueries,
  };
}

function fakeOff(table: Record<string, OffResolution>): OffPort {
  return {
    lookup: (barcode) => table[barcode] ?? { state: "pending", text: null },
    dispose: () => undefined,
  };
}

function ocrSignal(text: string, at: number): ScanSignal {
  return { source: "ocr", text, confidence: 0.9, at };
}

function barcodeSignal(text: string, at: number): ScanSignal {
  return { source: "barcode", text, confidence: 1, at };
}

function imageResult(components: Record<number, number>, capturedAt: number): FrameEmbedResult {
  return {
    frame: { jpeg: new Blob([new Uint8Array(4)], { type: "image/jpeg" }), width: 384, height: 288, capturedAt },
    embedding: { vector: vec(components), dims: 256, embedMs: 1, backend: "fake", model: "fake" },
  };
}

function makeController(
  list: ScanList,
  embed: FakeEmbed,
  off: OffPort,
  timeRef: { now: number },
): { controller: ScanController; states: ScanUiState[] } {
  const clock: Clock = { now: () => timeRef.now };
  const states: ScanUiState[] = [];
  const controller = createScanController({
    list,
    embed: embed.port,
    off,
    clock,
    onChange: (state) => states.push(state),
  });
  return { controller, states };
}

function last(states: ScanUiState[]): ScanUiState {
  const state = states[states.length - 1];
  if (state === undefined) throw new Error("controller emitted no state");
  return state;
}

describe("pool order through the tick pipeline", () => {
  it("keeps a barcode that arrives AFTER 16 OCR lines (barcode-first pool)", () => {
    const time = { now: 10_000 };
    const names = ["Target", ...Array.from({ length: 16 }, (_, index) => `Line ${index + 1}`)];
    const list = makeList(names);
    const flat = flatten(list);

    // One OCR query per line with a decaying similarity; the OFF text aligns exactly with "Target".
    const queries = gradedLineQueries(16);
    queries.set("Target", vec({ 0: 1 }));
    const embed = fakeEmbed(docMap(flat), queries);
    const off = fakeOff({ "3017620422003": { state: "found", text: "Target" } });
    const { controller, states } = makeController(list, embed, off, time);

    for (let index = 1; index <= 16; index += 1) {
      controller.ingestSignal(ocrSignal(`line ${index}`, time.now));
    }
    // The barcode is found LAST — the exact order that used to push it out of the pool.
    controller.ingestSignal(barcodeSignal("3017620422003", time.now));
    controller.tick(time.now);

    const state = last(states);
    expect(state.hero?.name).toBe("Target");
    // Barcode + 15 OCR lines = 16; the 16th OCR line is the one dropped, never the barcode.
    expect(state.queries.text).toBe(16);
    expect(state.chips.find((chip) => chip.key === "barcode")?.detail).toBe("3017620422003");
    expect(state.chips.find((chip) => chip.key === "queries")?.detail).toBe("16/16");
  });

  it("without a barcode the same 16 OCR lines pick the sharpest line instead", () => {
    const time = { now: 10_000 };
    const names = ["Target", ...Array.from({ length: 16 }, (_, index) => `Line ${index + 1}`)];
    const list = makeList(names);
    const flat = flatten(list);
    const queries = gradedLineQueries(16);

    const embed = fakeEmbed(docMap(flat), queries);
    const { controller, states } = makeController(list, embed, fakeOff({}), time);
    for (let index = 1; index <= 16; index += 1) controller.ingestSignal(ocrSignal(`line ${index}`, time.now));
    controller.tick(time.now);

    expect(last(states).hero?.name).toBe("Line 1");
  });
});

describe("hero gates through the controller", () => {
  it("renders the null hero honestly when two lines are ambiguous", () => {
    const time = { now: 1000 };
    const list = makeList(["Milk", "Bread"]);
    const flat = flatten(list);
    const queries = new Map<string, number[]>([["ambiguous", vec({ 0: 0.8, 1: 0.78 })]]);
    const embed = fakeEmbed(docMap(flat), queries);
    const { controller, states } = makeController(list, embed, fakeOff({}), time);

    controller.ingestSignal(ocrSignal("ambiguous", time.now));
    controller.tick(time.now);

    const state = last(states);
    expect(state.hero).toBeNull();
    expect(state.ranked).toBe(true);
    expect(state.rows.map((row) => row.name)).toEqual(["Milk", "Bread"]);
    expect(state.heroStatus).toContain("Nothing is a confident match");
  });

  it("an image-driven hero needs the barcode accept-list confirmation", () => {
    const time = { now: 1000 };
    const list = makeList(["Milk", "Bread"]);
    const flat = flatten(list);

    // Text queries stay unembedded, so the only query vector is the image: source = image.
    const embed = fakeEmbed(docMap(flat), new Map());
    const off = fakeOff({ "3017620422003": { state: "found", text: "Milk" } });
    const { controller, states } = makeController(list, embed, off, time);

    controller.ingestSignal(barcodeSignal("3017620422003", time.now));
    controller.ingestImage(imageResult({ 0: 1 }, time.now));
    controller.tick(time.now);

    expect(last(states).hero?.name).toBe("Milk");
    expect(last(states).queries.pending).toBe(1); // the OFF text is still embedding

    // Same image evidence, barcode resolves to a product that is not on the list -> no hero.
    const other = makeController(
      list,
      fakeEmbed(docMap(flat), new Map()),
      fakeOff({ "4006381333931": { state: "found", text: "Nutella" } }),
      time,
    );
    other.controller.ingestSignal(barcodeSignal("4006381333931", time.now));
    other.controller.ingestImage(imageResult({ 0: 1 }, time.now));
    other.controller.tick(time.now);
    expect(last(other.states).hero).toBeNull();
  });

  it("keeps the top-1 order in rows even when topId is null", () => {
    const time = { now: 500 };
    const list = makeList(["Milk", "Bread"]);
    const flat = flatten(list);
    const queries = new Map<string, number[]>([["q", vec({ 0: 0.6, 1: 0.5 })]]); // below floor
    const { controller, states } = makeController(list, fakeEmbed(docMap(flat), queries), fakeOff({}), time);

    controller.ingestSignal(ocrSignal("q", time.now));
    controller.tick(time.now);

    expect(last(states).hero).toBeNull();
    expect(last(states).rows.map((row) => row.name)).toEqual(["Milk", "Bread"]);
    expect(last(states).rows[0]?.score).toBeGreaterThan(last(states).rows[1]?.score ?? 1);
  });
});

describe("ticking is manual (never auto-commit)", () => {
  it("many ticks change nothing until the caller commits an item", () => {
    const time = { now: 1000 };
    const list = makeList(["Milk", "Bread"]);
    const flat = flatten(list);
    const queries = new Map<string, number[]>([
      ["milk label", vec({ 0: 1 })],
      ["bread label", vec({ 1: 0.866, 255: 0.5 })],
    ]);
    const { controller, states } = makeController(list, fakeEmbed(docMap(flat), queries), fakeOff({}), time);

    controller.ingestSignal(ocrSignal("milk label", time.now));
    controller.ingestSignal(ocrSignal("bread label", time.now));
    controller.tick(time.now);
    controller.tick(time.now + 400);
    controller.tick(time.now + 800);

    expect(last(states).hero?.name).toBe("Milk");
    expect(flatten(list).filter((item) => item.done)).toHaveLength(0);

    // The user ticks "Milk" on the list (C2's path mutates the original item, then app.tsx re-renders).
    (list.sections[0]?.items?.[0] as { done?: boolean }).done = true;
    controller.setList(list);
    controller.tick(time.now + 1200);

    expect(last(states).hero?.name).toBe("Bread");
    expect(last(states).rows.find((row) => row.name === "Milk")?.done).toBe(true);
  });
});

describe("embedding + evidence lifecycle", () => {
  it("reports item-document embedding progress before the first hero", () => {
    const time = { now: 1000 };
    const list = makeList(["Milk", "Bread"]);
    const flat = flatten(list);
    const embed = fakeEmbed(); // nothing embedded yet
    const { controller, states } = makeController(list, embed, fakeOff({}), time);

    expect(controller.state().phase).toBe("preparing");
    expect(controller.state().prepared).toEqual({ done: 0, total: 2 });
    expect(embed.requestedDocs).toEqual([docText(flat[0]!), docText(flat[1]!)]);

    const docs = docMap(flat);
    for (const [text, vector] of docs) embed.docs.set(text, vector);
    controller.tick(time.now);

    expect(last(states).phase).toBe("ready");
    expect(last(states).prepared).toEqual({ done: 2, total: 2 });
  });

  it("expires barcode and OCR evidence on their TTLs", () => {
    const time = { now: 1000 };
    const list = makeList(["Milk", "Bread"]);
    const flat = flatten(list);
    const queries = new Map<string, number[]>([["label", vec({ 0: 1 })]]);
    const { controller, states } = makeController(
      list,
      fakeEmbed(docMap(flat), queries),
      fakeOff({ "3017620422003": { state: "found", text: "Milk" } }),
      time,
    );

    controller.ingestSignal(barcodeSignal("3017620422003", time.now));
    controller.ingestSignal(ocrSignal("label", time.now));
    controller.tick(time.now);
    expect(last(states).chips.find((chip) => chip.key === "barcode")?.active).toBe(true);
    expect(last(states).chips.find((chip) => chip.key === "ocr")?.active).toBe(true);

    // OCR line TTL is 2.5 s, barcode hold 4 s: at +3 s only the barcode is live.
    time.now += 3000;
    controller.tick(time.now);
    expect(last(states).chips.find((chip) => chip.key === "ocr")?.active).toBe(false);
    expect(last(states).chips.find((chip) => chip.key === "barcode")?.active).toBe(true);

    time.now += 1500;
    controller.tick(time.now);
    expect(last(states).chips.find((chip) => chip.key === "barcode")?.active).toBe(false);
  });

  it("survives a malformed image vector without killing the loop", () => {
    const time = { now: 1000 };
    const list = makeList(["Milk"]);
    const flat = flatten(list);
    const { controller, states } = makeController(list, fakeEmbed(docMap(flat)), fakeOff({}), time);

    // A 2-d vector is not 256-d: rank() defers/invalidates it, the controller must not throw.
    controller.ingestImage({
      frame: { jpeg: new Blob(), width: 1, height: 1, capturedAt: time.now },
      embedding: { vector: [1, 0], dims: 2, embedMs: 1, backend: "fake", model: "fake" },
    });
    expect(() => controller.tick(time.now)).not.toThrow();
    expect(last(states).hero).toBeNull();
  });
});
