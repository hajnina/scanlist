import { describe, expect, it } from "vitest";

import {
  IMAGES_PER_BATCH,
  IMAGE_TOKENS,
  MAX_BATCH_TOKENS,
  MAX_TEXT_CHARS,
  applyPrefix,
  capText,
  docInput,
  estimateTextTokens,
  imageInput,
  planBatches,
  planImageBatches,
  prefixesFromSpec,
  queryInput,
} from "./budget";

const SPEC = {
  version: 1,
  active: "mnemothera",
  imagePrefix: "",
  mnemothera: { doc: "task: search result | text: ", query: "task: search query | text: " },
  modelcard: { doc: "title: none | text: ", query: "task: search result | query: " },
};

describe("prefixesFromSpec", () => {
  it("reads the ACTIVE prefix set and the image prefix, like embedder_gemma.load_prefixes", () => {
    const prefixes = prefixesFromSpec(SPEC);
    expect(prefixes).toEqual({
      active: "mnemothera",
      doc: "task: search result | text: ",
      query: "task: search query | text: ",
      image: "",
    });
  });

  it("follows a different active set instead of hard-coding one", () => {
    const prefixes = prefixesFromSpec({ ...SPEC, active: "modelcard" });
    expect(prefixes.doc).toBe("title: none | text: ");
    expect(prefixes.query).toBe("task: search result | query: ");
  });

  it("rejects a spec without an active set or with an unknown one", () => {
    expect(() => prefixesFromSpec({})).toThrow(/active/);
    expect(() => prefixesFromSpec({ active: "nope" })).toThrow(/no matching prefix set/);
    expect(() => prefixesFromSpec({ active: "x", x: { doc: 1, query: "" } })).toThrow(/string/);
  });
});

describe("text inputs (prefix + trim + cap)", () => {
  const prefixes = prefixesFromSpec(SPEC);

  it("docText gets the DOC prefix; a query gets the QUERY prefix", () => {
    expect(docInput(prefixes, "Bananas; Fresh > Fruit & veg")).toBe(
      "task: search result | text: Bananas; Fresh > Fruit & veg",
    );
    expect(queryInput(prefixes, "bananas")).toBe("task: search query | text: bananas");
  });

  it("trims once and hard-caps the text (server DEFAULT_MAX_CHARS = 2048 / cap_text)", () => {
    const long = `   ${"a".repeat(MAX_TEXT_CHARS + 50)}   `;
    const capped = capText(long);
    expect(capped.length).toBe(MAX_TEXT_CHARS);
    expect(capped.endsWith(" ")).toBe(false);
    expect(applyPrefix("p:", long)).toBe(`p:${"a".repeat(MAX_TEXT_CHARS)}`);
  });

  it("images take NO prefix — the model card says images/video/audio are unprefixed", () => {
    expect(imageInput(prefixes)).toBe("");
    expect(prefixes.image).toBe("");
  });
});

describe("token budget + batching", () => {
  it("keeps each batch at or under 2,700 tokens and covers every input exactly once", () => {
    // 10 docs of 300 tokens → 2700 exactly would fit, but greedy packing gives 9 + 1.
    const inputs = Array.from({ length: 10 }, () => ({ kind: "text" as const, tokens: 300 }));
    const batches = planBatches(inputs);
    expect(batches.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const batch of batches) {
      const tokens = batch.reduce((sum, index) => sum + (inputs[index] as { tokens: number }).tokens, 0);
      expect(tokens).toBeLessThanOrEqual(MAX_BATCH_TOKENS);
    }
    expect(batches).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8], [9]]);
  });

  it("packs greedily across text and image costs without mixing the rule sets", () => {
    expect(planBatches([{ kind: "text", tokens: 2600 }, { kind: "text", tokens: 200 }])).toEqual([
      [0],
      [1],
    ]);
    expect(planBatches([])).toEqual([]);
  });

  it("gives an oversized single input its own batch instead of dropping it", () => {
    expect(planBatches([{ kind: "text", tokens: 3000 }])).toEqual([[0]]);
    expect(() => planBatches([{ kind: "text", tokens: -1 }])).toThrow(RangeError);
  });

  it("batches at most 9 images at 280 tokens each (2520 ≤ 2700), and never flat", () => {
    expect(IMAGES_PER_BATCH).toBe(9);
    const oneImage = planImageBatches(1);
    expect(oneImage).toEqual([[0]]);
    expect(planImageBatches(9)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8]]);
    expect(planImageBatches(10)).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [9],
    ]);
    // 10 images at once would be 2800 tokens — over budget.
    expect(10 * IMAGE_TOKENS).toBeGreaterThan(MAX_BATCH_TOKENS);
    expect(planImageBatches(0)).toEqual([]);
    expect(() => planImageBatches(1.5)).toThrow(RangeError);
  });

  it("estimateTextTokens over-estimates rather than under-estimates", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("a".repeat(9))).toBe(3);
    expect(estimateTextTokens("")).toBe(1);
  });
});
