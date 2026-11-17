/**
 * The S8 done-when: replay the whole S3 golden fixture through *this* TS core with no model.
 *
 * - flatten: all 44 sample items must equal golden.json's `lists[].items` (ids, order, fields)
 *   and their `docText` must be byte-identical;
 * - rank: all 58 queries (43 text + 15 image, 5 lists / 88 items) must produce the oracle's
 *   `expectedTop3`, `expectedScores` and `expectedMargin`.
 */

import { describe, expect, it } from "vitest";

import { docText, flatten } from "../src/flatten";
import { parseList } from "../src/parse";
import { q6, rank } from "../src/rank";
import type { RankItem } from "../src/types";
import { golden, goldenListsById, samples } from "./fixtures";
import { must } from "./helpers";

function itemsWithVectors(listId: string): RankItem[] {
  const list = must(goldenListsById.get(listId));
  return list.items.map((item) => ({
    ...item,
    vec: must(list.itemVectors[item.id]),
  }));
}

describe("golden.json — fixture shape", () => {
  it("has 5 lists / 88 items (44 sample + 44 photo corpus) and 58 queries", () => {
    expect(golden.lists).toHaveLength(5);
    expect(golden.lists.reduce((sum, list) => sum + list.items.length, 0)).toBe(88);
    expect(golden.lists.map((list) => list.id)).toEqual([
      "van-weekly",
      "string-amounts",
      "aliases-es-cz",
      "deep-nesting",
      "photo-corpus",
    ]);
    expect(golden.queries).toHaveLength(58);
    expect(golden.queries.filter((query) => query.kind === "text")).toHaveLength(43);
    expect(golden.queries.filter((query) => query.kind === "image")).toHaveLength(15);
    expect(golden.dims.active).toBe(256);

    for (const list of golden.lists) {
      expect(list.items).toHaveLength(list.itemCount);
      expect(Object.keys(list.itemVectors).sort()).toEqual(
        list.items.map((item) => item.id).sort(),
      );
      for (const item of list.items) {
        expect("vec" in item, "flattened items carry no vec key").toBe(false);
        expect(must(list.itemVectors[item.id])).toHaveLength(256);
      }
    }
  });
});

describe("golden.json — byte-identical flatten (44 sample items)", () => {
  for (const sample of samples) {
    it(`flattens ${sample.name} exactly like the oracle`, () => {
      const parsed = parseList(sample.text);
      expect(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.errors)).toBe(true);
      if (!parsed.ok) return;

      const flat = flatten(parsed.list);
      const expected = must(goldenListsById.get(sample.name)).items;
      expect(flat).toHaveLength(sample.itemCount);
      expect(flat).toEqual(expected);

      // Explicit docText comparison as the card asks (ids + docText byte-for-byte).
      expect(flat.map((item) => item.id)).toEqual(expected.map((item) => item.id));
      expect(flat.map(docText)).toEqual(expected.map(docText));
    });
  }

  it("covers all 44 real sample items across the four files", () => {
    const total = samples.reduce((sum, sample) => {
      const parsed = parseList(sample.text);
      return sum + (parsed.ok ? flatten(parsed.list).length : -1);
    }, 0);
    expect(total).toBe(44);
  });
});

describe("golden.json — full rank replay (model-free)", () => {
  for (const query of golden.queries) {
    it(`${query.id} (${query.kind}, ${query.list}) matches the oracle top-3`, () => {
      const items = itemsWithVectors(query.list);
      const queries =
        query.kind === "text"
          ? { text: [query.vector], image: [] }
          : { text: [], image: [query.vector] };

      const out = rank(items, queries, null, null);
      expect(out.ranked).toBe(true);

      const candidates = out.entries.filter((entry) => !entry.done);
      expect(candidates.slice(0, 3).map((entry) => entry.id)).toEqual(query.expectedTop3);
      expect(candidates.slice(0, 3).map((entry) => entry.smoothed)).toEqual(
        query.expectedScores,
      );

      const top1 = must(candidates[0]).smoothed;
      const top2 = must(candidates[1]).smoothed;
      expect(q6((top1 as number) - (top2 as number))).toBe(query.expectedMargin);

      if (query.expect === "hit") {
        // `accept` is non-empty for hits. Note: icheese is the known S10 false highlight
        // (cheese.jpg -> Greek yoghurt), so accept deliberately does NOT contain every oracle
        // top-1; the golden contract here is top-3/scores, not the highlight gate.
        expect(query.accept.length).toBeGreaterThan(0);
      }
    });
  }

  it("replays all 58 queries", () => {
    let checked = 0;
    for (const query of golden.queries) {
      const out = rank(
        itemsWithVectors(query.list),
        query.kind === "text"
          ? { text: [query.vector], image: [] }
          : { text: [], image: [query.vector] },
        null,
        null,
      );
      expect(out.entries.filter((entry) => !entry.done).slice(0, 3).map((entry) => entry.id))
        .toEqual(query.expectedTop3);
      checked += 1;
    }
    expect(checked).toBe(58);
  });
});
