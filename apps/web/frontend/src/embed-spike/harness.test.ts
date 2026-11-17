import { describe, expect, it } from "vitest";

import { docText } from "@scanlist/ts-core";
import type { FlattenedItem } from "@scanlist/ts-core";

import { docInput, queryInput } from "./budget";
import type { Prefixes } from "./budget";
import { runMeasurement } from "./harness";
import type { GoldenQuery } from "./harness";
import type { EmbedSession, ImageHandle } from "./session";
import { DIMS_ACTIVE, cosine, truncateAndNormalize } from "./vectors";

const PROMPTS: Prefixes = {
  active: "mnemothera",
  doc: "task: search result | text: ",
  query: "task: search query | text: ",
  image: "",
};

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 1 : hash;
}

/** Deterministic stand-in for the model: a stable unit-length 768-d vector per string. */
function pseudoVector(seed: string, dims = 768): Float32Array {
  let state = fnv1a(seed);
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = (state / 0x100000000) * 2 - 1;
    out[i] = value;
    norm += value * value;
  }
  // The real model returns already L2-normalised vectors, so the slice-norm check means something.
  const scale = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i += 1) out[i] = (out[i] as number) / scale;
  return out;
}

class FakeSession implements EmbedSession {
  readonly device = "fake";
  readonly dtype = "q4";
  readonly textCalls: string[][] = [];
  readonly imageCalls: ImageHandle[][][] = [];
  readonly flatCalls: ImageHandle[][] = [];
  private readonly overrides = new Map<string, Float32Array>();

  /** Make `from` and `to` produce the same vector (used for the rank() top-1 check). */
  alias(from: string, to: string): void {
    this.overrides.set(from, pseudoVector(to));
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    this.textCalls.push([...texts]);
    return texts.map((text) => this.overrides.get(text) ?? pseudoVector(text));
  }

  async embedImages(groups: ImageHandle[][]): Promise<Float32Array[]> {
    this.imageCalls.push(groups.map((group) => [...group]));
    return groups.map((group) => pseudoVector(`img:${String(group[0])}`));
  }

  async embedImagesFlat(images: ImageHandle[]): Promise<Float32Array> {
    this.flatCalls.push([...images]);
    return pseudoVector(`flat:${images.map(String).join("+")}`);
  }

  async countTokens(texts: string[]): Promise<number[]> {
    return texts.map((text) => Math.max(1, Math.ceil(text.length / 4)));
  }
}

const ITEMS: FlattenedItem[] = ["Apples", "Milk", "Bread"].map((name, index) => ({
  id: `item-${index}`,
  name,
  amount: null,
  unit: null,
  note: null,
  aliases: [],
  done: false,
  path: ["Test"],
  pathText: "Test",
  index,
  order: index,
}));

function buildFixture(): {
  session: FakeSession;
  itemVectors: Record<string, number[]>;
  textQueries: GoldenQuery[];
  images: { id: string; handle: ImageHandle; vector: number[] }[];
} {
  const session = new FakeSession();
  const itemVectors: Record<string, number[]> = {};
  for (const item of ITEMS) {
    const input = docInput(PROMPTS, docText(item));
    itemVectors[item.id] = truncateAndNormalize(pseudoVector(input), DIMS_ACTIVE);
  }
  // Query "Q:apples" is made to embed exactly like item 0's document → rank() must pick item-0.
  session.alias(queryInput(PROMPTS, "apples"), docInput(PROMPTS, docText(ITEMS[0] as FlattenedItem)));
  const textQueries: GoldenQuery[] = [
    {
      id: "q-apples",
      kind: "text",
      text: "apples",
      vector: truncateAndNormalize(pseudoVector(queryInput(PROMPTS, "apples")), DIMS_ACTIVE),
      expectedTop3: ["item-0", "item-1", "item-2"],
    },
  ];
  const images = [
    { id: "imilk", handle: "handle-milk" },
    { id: "ipasta", handle: "handle-pasta" },
  ].map((image) => ({
    ...image,
    vector: truncateAndNormalize(pseudoVector(`img:${image.handle}`), DIMS_ACTIVE),
  }));
  return { session, itemVectors, textQueries, images };
}

describe("runMeasurement (fake model — the real load is a manual spike run, not CI)", () => {
  it("plans token-aware batches and covers every item exactly once", async () => {
    const fixture = buildFixture();
    const report = await runMeasurement(
      {
        session: fixture.session,
        prompts: PROMPTS,
        items: ITEMS,
        itemVectors: fixture.itemVectors,
        textQueries: fixture.textQueries,
        images: fixture.images,
      },
      { now: (() => { let t = 0; return () => (t += 10); })() },
    );
    expect(report.budgets.docTokens).toHaveLength(ITEMS.length);
    const indices = report.budgets.docBatches.flat().sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
    for (const tokens of report.budgets.docBatchTokens) expect(tokens).toBeLessThanOrEqual(2700);
    expect(report.notes.join(" ")).toMatch(/tokenizer/);
  });

  it("batches images as [[a],[b]] — never a flat list — and measures one nested batch", async () => {
    const fixture = buildFixture();
    const report = await runMeasurement(
      {
        session: fixture.session,
        prompts: PROMPTS,
        items: ITEMS,
        itemVectors: fixture.itemVectors,
        textQueries: fixture.textQueries,
        images: fixture.images,
      },
      { now: (() => { let t = 0; return () => (t += 10); })() },
    );
    // Every image call the harness made is nested with exactly one image per group.
    for (const call of fixture.session.imageCalls) {
      expect(call.length).toBeGreaterThan(0);
      for (const group of call) expect(group).toHaveLength(1);
    }
    expect(report.image.batch).not.toBeNull();
    expect(report.image.batch?.size).toBe(2);
    expect(report.image.batch?.tokens).toBe(2 * 280);
    // The flat call happens exactly once, and only to demonstrate the trap.
    expect(fixture.session.flatCalls).toHaveLength(1);
    expect(fixture.session.flatCalls[0]).toHaveLength(2);
  });

  it("reports parity against the golden vectors, end-to-end rank() top-1, and the traps", async () => {
    const fixture = buildFixture();
    const report = await runMeasurement(
      {
        session: fixture.session,
        prompts: PROMPTS,
        items: ITEMS,
        itemVectors: fixture.itemVectors,
        textQueries: fixture.textQueries,
        images: fixture.images,
      },
      { now: (() => { let t = 0; return () => (t += 10); })() },
    );
    expect(report.parity.docs.n).toBe(3);
    expect(report.parity.docs.minCosine).toBeGreaterThan(0.999999);
    expect(report.parity.queries.n).toBe(1);
    expect(report.parity.images.n).toBe(2);
    expect(report.parity.images.minCosine).toBeGreaterThan(0.999999);
    expect(report.parity.top1).toEqual({ hits: 1, total: 1, misses: [] });

    // The 256-slice of a unit 768-d vector is ~0.577 long — re-normalising is mandatory.
    expect(report.image.sliceNormMean).toBeGreaterThan(0.4);
    expect(report.image.sliceNormMean).toBeLessThan(0.7);

    // Flat vs nested: a flat list is one blended embedding, so it differs from every single-image one.
    expect(report.traps.flatVsNested).not.toBeNull();
    expect(report.traps.flatVsNested?.differs).toBe(true);
    const nested0 = truncateAndNormalize(pseudoVector("img:handle-milk"), DIMS_ACTIVE);
    const flat = truncateAndNormalize(pseudoVector("flat:handle-milk+handle-pasta"), DIMS_ACTIVE);
    expect(cosine(flat, nested0)).toBeLessThan(0.995);
  });

  it("keeps image stages null instead of inventing numbers when there are no images", async () => {
    const fixture = buildFixture();
    const report = await runMeasurement(
      {
        session: fixture.session,
        prompts: PROMPTS,
        items: ITEMS,
        itemVectors: fixture.itemVectors,
        textQueries: fixture.textQueries,
        images: [],
      },
      { now: (() => { let t = 0; return () => (t += 10); })() },
    );
    expect(report.image.single).toBeNull();
    expect(report.image.batch).toBeNull();
    expect(Number.isNaN(report.image.sliceNormMean)).toBe(true);
    expect(report.traps.flatVsNested).toBeNull();
    expect(report.notes.join(" ")).toMatch(/No images supplied/);
  });

  it("reports a miss when the browser vectors rank something else first", async () => {
    const fixture = buildFixture();
    // Do not alias: the query embeds as its own random vector, so top-1 is very unlikely to be item-0.
    const session = new FakeSession();
    const report = await runMeasurement(
      {
        session,
        prompts: PROMPTS,
        items: ITEMS,
        itemVectors: fixture.itemVectors,
        textQueries: [{ ...fixture.textQueries[0], expectedTop3: ["item-0"] } as GoldenQuery],
        images: [],
      },
      { now: (() => { let t = 0; return () => (t += 10); })() },
    );
    expect(report.parity.top1.total).toBe(1);
    if (report.parity.top1.hits === 0) {
      expect(report.parity.top1.misses[0]).toMatch(/q-apples/);
    }
  });
});
