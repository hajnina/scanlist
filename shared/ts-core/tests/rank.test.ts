import { describe, expect, it } from "vitest";

import {
  barcodeMatch,
  cosine,
  decideTop,
  normBarcodeText,
  q6,
  rank,
  sortCandidates,
  unranked,
} from "../src/rank";
import type { RankedCandidate } from "../src/rank";
import type { RankEntry, RankItem, RankOutput } from "../src/types";
import { makeItem } from "./helpers";

function milkItems(): RankItem[] {
  return [
    makeItem("a", [1, 0, 0, 0], { order: 0, name: "Milk" }),
    makeItem("b", [0.6, 0.8, 0, 0], { order: 1, name: "Oat milk" }),
    makeItem("c", [0, 0, 1, 0], { order: 2, name: "Bread" }),
  ];
}

function textQueries(...vectors: number[][]): { text: number[][]; image: number[][] } {
  return { text: vectors, image: [] };
}

function tick(
  items: readonly RankItem[],
  query: number[],
  prev: unknown = null,
  barcodeName: string | null = null,
): RankOutput {
  return rank(items, textQueries(query), prev as never, barcodeName, { dims: 4 });
}

function ids(entries: readonly RankEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

function scores(entries: readonly RankEntry[]): [string, number | null, number | null][] {
  return entries.map((entry) => [entry.id, entry.raw, entry.smoothed]);
}

describe("q6 (RANK.md §5)", () => {
  it("rounds half away from zero", () => {
    expect(q6(0.1234565)).toBe(0.123457);
    expect(q6(-0.1234565)).toBe(-0.123457);
    expect(q6(0.0000004)).toBe(0);
    expect(q6(0.0000005)).toBe(0.000001);
  });

  it("is idempotent on six-decimal values", () => {
    for (const value of [0, 0.02, 0.09, 0.85, 0.915, 0.94875, -1, 1.15]) {
      expect(q6(q6(value))).toBe(q6(value));
    }
  });

  it("normalises negative zero and non-finite values", () => {
    expect(Object.is(q6(-0), 0)).toBe(true);
    expect(q6(-1e-9)).toBe(0);
    expect(Object.is(q6(-1e-9), 0)).toBe(true);
    expect(q6(Number.NaN)).toBe(0);
    expect(q6(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("pins the two spec comparison examples", () => {
    expect(q6(0.87 - 0.85)).toBe(0.02);
    expect(q6(0.915 - 0.825)).toBe(0.09);
  });
});

describe("cosine and vectors (RANK.md §2)", () => {
  it("is a dot product accumulated in index order", () => {
    expect(cosine([1, 0, 0, 0], [0.6, 0.8, 0, 0], 4)).toBe(0.6);
    expect(cosine([0, 0, 0, 0], [1, 0, 0, 0], 4)).toBe(0);
  });
});

describe("RANK.md §10 worked example", () => {
  it("tick 1: first observation equals raw", () => {
    const out = tick(milkItems(), [1, 0, 0, 0]);
    expect(out.ranked).toBe(true);
    expect(out.topId).toBe("a");
    expect(scores(out.entries)).toEqual([
      ["a", 1, 1],
      ["b", 0.6, 0.6],
      ["c", 0, 0],
    ]);
    expect(out.state.smoothed).toEqual({ a: 1, b: 0.6, c: 0 });
    expect(out.state.topId).toBe("a");
  });

  it("tick 2: EMA is the arithmetic mean, top stays", () => {
    const out = tick(milkItems(), [0.8, 0.6, 0, 0], tick(milkItems(), [1, 0, 0, 0]).state);
    expect(out.topId).toBe("a");
    expect(scores(out.entries)).toEqual([
      ["a", 0.8, 0.9],
      ["b", 0.96, 0.78],
      ["c", 0, 0],
    ]);
  });

  it("tick 3: a 0.02 margin is NOT enough to switch the top", () => {
    const s1 = tick(milkItems(), [1, 0, 0, 0]).state;
    const s2 = tick(milkItems(), [0.8, 0.6, 0, 0], s1).state;
    const out = tick(milkItems(), [0.8, 0.6, 0, 0], s2);
    expect(out.state.smoothed).toEqual({ a: 0.85, b: 0.87, c: 0 });
    expect(out.topId).toBe("a");
    expect(ids(out.entries)).toEqual(["a", "b", "c"]);
  });

  it("tick 4: a 0.09 margin switches the top", () => {
    const s1 = tick(milkItems(), [1, 0, 0, 0]).state;
    const s2 = tick(milkItems(), [0.8, 0.6, 0, 0], s1).state;
    const s3 = tick(milkItems(), [0.8, 0.6, 0, 0], s2).state;
    const out = tick(milkItems(), [0.8, 0.6, 0, 0], s3);
    expect(out.state.smoothed).toEqual({ a: 0.825, b: 0.915, c: 0 });
    expect(q6(0.915 - 0.825)).toBe(0.09);
    expect(out.topId).toBe("b");
    expect(ids(out.entries)).toEqual(["b", "a", "c"]);
  });

  it("tick 5: the ticked top leaves and sinks with no hysteresis", () => {
    let state = tick(milkItems(), [1, 0, 0, 0]).state;
    for (let i = 0; i < 3; i += 1) {
      state = tick(milkItems(), [0.8, 0.6, 0, 0], state).state;
    }
    const ticked = milkItems().map((item, index) =>
      index === 0 ? { ...item, done: true } : item,
    );
    const out = tick(ticked, [0.8, 0.6, 0, 0], state);
    expect(out.topId).toBe("b");
    expect(scores(out.entries)).toEqual([
      ["b", 0.96, 0.9375],
      ["c", 0, 0],
      ["a", null, null],
    ]);
    expect(out.entries[2]?.done).toBe(true);
    expect("a" in out.state.smoothed).toBe(false);
  });

  it("untick restarts from the current raw", () => {
    let state = tick(milkItems(), [1, 0, 0, 0]).state;
    for (let i = 0; i < 3; i += 1) {
      state = tick(milkItems(), [0.8, 0.6, 0, 0], state).state;
    }
    const ticked = milkItems().map((item, index) =>
      index === 0 ? { ...item, done: true } : item,
    );
    const afterTick = tick(ticked, [0.8, 0.6, 0, 0], state);
    const out = tick(milkItems(), [0.8, 0.6, 0, 0], afterTick.state);
    expect(out.topId).toBe("b");
    expect(scores(out.entries)).toEqual([
      ["b", 0.96, 0.94875],
      ["a", 0.8, 0.8],
      ["c", 0, 0],
    ]);
  });

  it("barcode boost example and smoothing of the boost", () => {
    const first = tick(milkItems().slice(0, 2), [0.6, 0.8, 0, 0], null, "milk");
    expect(scores(first.entries)).toEqual([
      ["b", 1, 1],
      ["a", 0.75, 0.75],
    ]);
    const second = tick(milkItems().slice(0, 2), [0.6, 0.8, 0, 0], first.state, null);
    expect(scores(second.entries)).toEqual([
      ["b", 1, 1],
      ["a", 0.6, 0.675],
    ]);
  });

  it("the boost alone never ranks", () => {
    const out = rank(
      milkItems().slice(0, 2),
      { text: [], image: [] },
      null,
      "milk",
      { dims: 4 },
    );
    expect(out.ranked).toBe(false);
    expect(out.topId).toBeNull();
    expect(out.state).toEqual({ smoothed: {}, topId: null });
  });
});

describe("scoring: fusion and barcode matching (RANK.md §3)", () => {
  it("fuses with max, not mean", () => {
    const items = [makeItem("x", [1, 0, 0, 0], { order: 0 })];
    const out = rank(
      items,
      { text: [[0, 1, 0, 0]], image: [[1, 0, 0, 0]] },
      null,
      null,
      { dims: 4 },
    );
    expect(scores(out.entries)).toEqual([["x", 1, 1]]);
  });

  it("takes the max within a source and across sources", () => {
    const items = [makeItem("x", [1, 0, 0, 0], { order: 0 })];
    const out = rank(
      items,
      {
        text: [
          [0.6, 0.8, 0, 0],
          [0.8, 0.6, 0, 0],
        ],
        image: [[0, 1, 0, 0]],
      },
      null,
      null,
      { dims: 4 },
    );
    expect(scores(out.entries)).toEqual([["x", 0.8, 0.8]]);
  });

  it("keeps negative cosines", () => {
    const items = [makeItem("x", [1, 0, 0, 0], { order: 0 })];
    const out = rank(items, textQueries([-1, 0, 0, 0]), null, null, { dims: 4 });
    expect(scores(out.entries)).toEqual([["x", -1, -1]]);
  });

  it("matches the barcode name or alias exactly after normalisation", () => {
    const item = { name: "Oat milk", aliases: ["bebida de avena"] };
    expect(barcodeMatch(item, "Oat milk")).toBe(true);
    expect(barcodeMatch(item, "  oat   milk ")).toBe(true);
    expect(barcodeMatch(item, "BEBIDA DE AVENA")).toBe(true);
    expect(barcodeMatch(item, "Milk")).toBe(false);
    expect(barcodeMatch(item, "oat")).toBe(false);
    expect(barcodeMatch(item, null)).toBe(false);
    expect(barcodeMatch(item, "   ")).toBe(false);
  });

  it("normalises NFC and Unicode whitespace", () => {
    expect(normBarcodeText("  Hovězí   maso  ")).toBe("hovězí maso");
    expect(normBarcodeText("Mle\u0301ko")).toBe("mléko");
    expect(barcodeMatch({ name: "Mle\u0301ko", aliases: [] }, "ml\u00e9ko")).toBe(true);
  });

  it("adds the boost to raw and does not clip it", () => {
    const items = [
      makeItem("milk", [1, 0, 0, 0], { order: 0, name: "Milk", aliases: ["leche"] }),
      makeItem("bread", [1, 0, 0, 0], { order: 1, name: "Bread" }),
    ];
    const out = rank(items, textQueries([1, 0, 0, 0]), null, "leche", { dims: 4 });
    expect(scores(out.entries)).toEqual([
      ["milk", 1.15, 1.15],
      ["bread", 1, 1],
    ]);
  });

  it("gives a zero query vector cosine 0.0, never NaN", () => {
    const items = [makeItem("x", [1, 0, 0, 0], { order: 0 })];
    const out = rank(items, textQueries([0, 0, 0, 0]), null, null, { dims: 4 });
    expect(out.ranked).toBe(true);
    expect(scores(out.entries)).toEqual([["x", 0, 0]]);
  });

  it("drops NaN/Inf and wrong-dimension queries before ranking", () => {
    const items = [makeItem("x", [1, 0, 0, 0], { order: 0 })];
    const nan = rank(
      items,
      { text: [[Number.NaN, 0, 0, 0]], image: [[0, Number.POSITIVE_INFINITY, 0, 0]] },
      null,
      null,
      { dims: 4 },
    );
    expect(nan.ranked).toBe(false);
    expect(nan.entries[0]?.smoothed).toBeNull();

    const wrongDims = rank(items, { text: [[1, 0, 0]] }, null, null, { dims: 4 });
    expect(wrongDims.ranked).toBe(false);
  });

  it("caps text queries at 16", () => {
    const items = [makeItem("a", [1, 0, 0, 0], { order: 0 })];
    const queries = [
      ...Array.from({ length: 16 }, () => [0, 1, 0, 0]),
      [1, 0, 0, 0],
    ];
    const out = rank(items, { text: queries, image: [] }, null, null, { dims: 4 });
    expect(out.entries[0]?.raw).toBe(0);
  });
});

describe("ordering, ties, done group, state (RANK.md §4/§5/§6)", () => {
  it("breaks ties by flatten order, not input position", () => {
    const items = [
      makeItem("second", [0, 1, 0, 0], { order: 1, name: "Second" }),
      makeItem("first", [0, 1, 0, 0], { order: 0, name: "First" }),
    ];
    const out = rank(items, textQueries([0, 1, 0, 0]), null, null, { dims: 4 });
    expect(ids(out.entries)).toEqual(["first", "second"]);
    expect(out.topId).toBe("first");
    expect(out.entries[0]?.smoothed).toBe(1);
    expect(out.entries[1]?.smoothed).toBe(1);
  });

  it("sinks done items and never scores them", () => {
    const items = [
      makeItem("a", [1, 0, 0, 0], { order: 0, done: true }),
      makeItem("b", [0, 1, 0, 0], { order: 1 }),
      makeItem("c", [1, 0, 0, 0], { order: 2, done: true }),
      makeItem("d", [0, 1, 0, 0], { order: 3 }),
    ];
    const out = rank(items, textQueries([0, 1, 0, 0]), null, null, { dims: 4 });
    expect(ids(out.entries)).toEqual(["b", "d", "a", "c"]);
    expect(out.entries.map((entry) => entry.done)).toEqual([false, false, true, true]);
    expect(out.entries[2]?.raw).toBeNull();
    expect(out.entries[2]?.smoothed).toBeNull();
    expect(Object.keys(out.state.smoothed).sort()).toEqual(["b", "d"]);
  });

  it("handles all items checked and an empty list", () => {
    const allChecked = rank(
      [makeItem("a", [1, 0, 0, 0], { order: 0, done: true })],
      textQueries([1, 0, 0, 0]),
      null,
      null,
      { dims: 4 },
    );
    expect(allChecked.ranked).toBe(true);
    expect(allChecked.topId).toBeNull();
    expect(ids(allChecked.entries)).toEqual(["a"]);
    expect(allChecked.state).toEqual({ smoothed: {}, topId: null });

    const empty = rank([], textQueries([1, 0, 0, 0]), null, null, { dims: 4 });
    expect(empty).toEqual({
      ranked: true,
      topId: null,
      entries: [],
      state: { smoothed: {}, topId: null },
    });
  });

  it("promotes the next candidate immediately when the top is ticked", () => {
    const items = [
      makeItem("a", [1, 0, 0, 0], { order: 0, name: "A" }),
      makeItem("b", [0.6, 0.8, 0, 0], { order: 1, name: "B" }),
    ];
    const first = rank(items, textQueries([1, 0, 0, 0]), null, null, { dims: 4 });
    expect(first.topId).toBe("a");
    const out = rank(
      items.map((item) => (item.id === "a" ? { ...item, done: true } : item)),
      textQueries([1, 0, 0, 0]),
      first.state,
      null,
      { dims: 4 },
    );
    expect(out.topId).toBe("b");
    expect(ids(out.entries)).toEqual(["b", "a"]);
    expect("a" in out.state.smoothed).toBe(false);
  });

  it("ignores a previous top that is no longer a candidate and drops stale state", () => {
    const items = [makeItem("b", [0.6, 0.8, 0, 0], { order: 1 })];
    const out = rank(
      items,
      textQueries([1, 0, 0, 0]),
      { smoothed: { a: 1, b: 0.6 }, topId: "a" },
      null,
      { dims: 4 },
    );
    expect(out.topId).toBe("b");
    expect(Object.keys(out.state.smoothed)).toEqual(["b"]);
  });

  it("accepts a state, a whole rank output or a bare score map as prev", () => {
    const items = [makeItem("a", [1, 0, 0, 0], { order: 0 })];
    const first = rank(items, textQueries([1, 0, 0, 0]), null, null, { dims: 4 });
    const viaState = rank(items, textQueries([1, 0, 0, 0]), first.state, null, { dims: 4 });
    const viaOutput = rank(items, textQueries([1, 0, 0, 0]), first, null, { dims: 4 });
    const viaScores = rank(items, textQueries([1, 0, 0, 0]), { a: 1 }, null, { dims: 4 });
    expect(viaState.state.smoothed).toEqual({ a: 1 });
    expect(viaOutput.state.smoothed).toEqual({ a: 1 });
    expect(viaScores.state.smoothed).toEqual({ a: 1 });
    expect(viaScores.topId).toBe("a");
  });

  it("ignores a non-numeric previous smoothed value", () => {
    const items = [makeItem("a", [1, 0, 0, 0], { order: 0 })];
    const out = rank(
      items,
      textQueries([1, 0, 0, 0]),
      { smoothed: { a: "x" }, topId: null } as never,
      null,
      { dims: 4 },
    );
    expect(out.state.smoothed.a).toBe(1);
  });
});

describe("degraded states (RANK.md §8)", () => {
  it("returns flatten order, no scores and clears state with no signal", () => {
    const items = [
      makeItem("a", [1, 0, 0, 0], { order: 0 }),
      makeItem("b", null, { order: 1, done: true }),
    ];
    const out = rank(
      items,
      { text: [], image: [] },
      { smoothed: { a: 0.5 }, topId: "a" },
      null,
      { dims: 4 },
    );
    expect(out.ranked).toBe(false);
    expect(out.topId).toBeNull();
    expect(ids(out.entries)).toEqual(["a", "b"]);
    expect(out.entries.map((entry) => entry.done)).toEqual([false, true]);
    expect(out.entries.every((entry) => entry.raw === null && entry.smoothed === null)).toBe(true);
    expect(out.state).toEqual({ smoothed: {}, topId: null });
  });

  it("keeps the previous output when an item vector is missing", () => {
    const complete = [makeItem("a", [1, 0, 0, 0], { order: 0 })];
    const first = rank(complete, textQueries([1, 0, 0, 0]), null, null, { dims: 4 });
    const partial = [...complete, makeItem("b", null, { order: 1 })];
    const out = rank(partial, textQueries([1, 0, 0, 0]), first.state, null, {
      dims: 4,
      prevOutput: first,
    });
    expect(ids(out.entries)).toEqual(["a"]);
    expect(out.state).toEqual(first.state);
    expect(out.ranked).toBe(true);
  });

  it("returns unranked on the first tick when a vector is missing", () => {
    const items = [makeItem("a", null, { order: 0 })];
    const out = rank(items, textQueries([1, 0, 0, 0]), null, null, { dims: 4 });
    expect(out.ranked).toBe(false);
    expect(ids(out.entries)).toEqual(["a"]);
    expect(out.entries[0]?.smoothed).toBeNull();
  });

  it("treats wrong-dimension and non-finite item vectors as missing", () => {
    const wrongDims = rank(
      [makeItem("a", [1, 0, 0], { order: 0 })],
      textQueries([1, 0, 0, 0]),
      null,
      null,
      { dims: 4 },
    );
    expect(wrongDims.ranked).toBe(false);
    expect(wrongDims.topId).toBeNull();

    const nonFinite = rank(
      [makeItem("a", [1, Number.NaN, 0, 0], { order: 0 })],
      textQueries([1, 0, 0, 0]),
      null,
      null,
      { dims: 4 },
    );
    expect(nonFinite.ranked).toBe(false);
  });
});

describe("EMA exactness (RANK.md §4)", () => {
  it("applies alpha once per tick", () => {
    let state: RankOutput["state"] | null = null;
    let expected: number | null = null;
    for (const value of [1, 0.5, 0.75, 0.25]) {
      const item = makeItem("a", [value, 0, 0, 0], { order: 0 });
      const out = rank([item], textQueries([1, 0, 0, 0]), state, null, { dims: 4 });
      const raw = q6(value);
      expected = expected === null ? raw : q6(0.5 * raw + 0.5 * expected);
      expect(out.state.smoothed.a).toBe(expected);
      state = out.state;
    }
  });

  it("converges to 1.0 for a constant match", () => {
    let state: RankOutput["state"] | null = null;
    for (let i = 0; i < 4; i += 1) {
      const out = rank(
        [makeItem("a", [0.6, 0.8, 0, 0], { order: 0 })],
        textQueries([0.6, 0.8, 0, 0]),
        state,
        null,
        { dims: 4 },
      );
      state = out.state;
    }
    expect(state?.smoothed.a).toBe(1);
  });
});

describe("highlight decision is isolated (decideTop)", () => {
  function candidates(): RankedCandidate[] {
    return [
      { id: "b", raw: 0.87, smoothed: 0.87, done: false, order: 1 },
      { id: "a", raw: 0.85, smoothed: 0.85, done: false, order: 0 },
    ];
  }

  it("keeps the current top at exactly 0.02 and switches above it", () => {
    expect(decideTop(candidates(), "a")?.id).toBe("a");
    const higher = candidates();
    (higher[0] as RankedCandidate).smoothed = 0.88;
    expect(decideTop(higher, "a")?.id).toBe("b");
  });

  it("returns the best candidate with no current top, and null with none", () => {
    expect(decideTop(candidates(), null)?.id).toBe("b");
    expect(decideTop([], "a")).toBeNull();
  });

  it("falls back to the best if the current top is not a candidate", () => {
    expect(decideTop(candidates(), "gone")?.id).toBe("b");
  });

  it("sorts candidates by smoothed desc then order asc", () => {
    const sorted = sortCandidates(candidates());
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("unranked helper", () => {
  it("preserves flatten order and done flags", () => {
    const items = [
      makeItem("a", null, { order: 0 }),
      makeItem("b", null, { order: 1, done: true }),
    ];
    expect(unranked(items)).toEqual({
      ranked: false,
      topId: null,
      entries: [
        { id: "a", raw: null, smoothed: null, done: false },
        { id: "b", raw: null, smoothed: null, done: true },
      ],
      state: { smoothed: {}, topId: null },
    });
  });
});
