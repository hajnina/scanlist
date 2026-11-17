/**
 * Card C5 — retrieval prefixes come from `shared/spec/prompts.json`, never hard-coded
 * (`prompts.json.rules`: consumers MUST read the active set at runtime).
 */

import { describe, expect, it } from "vitest";

import { PROMPT_PREFIXES, applyPrefix, readPrefixes } from "../prompts";

describe("prompts.json prefixes", () => {
  it("reads the active mnemothera set (S3's A/B winner)", () => {
    expect(PROMPT_PREFIXES.active).toBe("mnemothera");
    expect(PROMPT_PREFIXES.model).toBe("embeddinggemma-2-740m");
    expect(PROMPT_PREFIXES.doc).toBe("task: search result | text: ");
    expect(PROMPT_PREFIXES.query).toBe("task: search query | text: ");
  });

  it("applies prefix + trim(text)", () => {
    expect(applyPrefix("P ", "  Milk  ")).toBe("P Milk");
    expect(applyPrefix("P ", "   ")).toBe("P ");
  });

  it("fails loudly on a malformed spec instead of embedding with an empty prefix", () => {
    expect(() => readPrefixes("{not json")).toThrow(/not valid JSON/);
    expect(() =>
      readPrefixes(JSON.stringify({ active: "missing", imagePrefix: "" })),
    ).toThrow(/missing/);
    expect(() =>
      readPrefixes(
        JSON.stringify({
          active: "set",
          model: "m",
          imagePrefix: "oops",
          set: { doc: "d", query: "q" },
        }),
      ),
    ).toThrow(/imagePrefix/);
    expect(() =>
      readPrefixes(JSON.stringify({ active: "set", model: "m", imagePrefix: "", set: { doc: 1, query: "q" } })),
    ).toThrow(/doc/);
  });
});
