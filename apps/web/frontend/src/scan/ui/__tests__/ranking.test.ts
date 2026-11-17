/**
 * Card C5 rank wiring: synthetic evidence → ts-core `rank()`/`decideTop()` → view rows.
 *
 * The hero decision is ts-core's (margin, floor, hysteresis, image accept-list guard). These tests
 * prove the *wiring* feeds it correctly and that the UI never invents a hero: `hero === null` is a
 * rendered state, and `topId === null` still leaves the full ranked order in `entries`.
 */

import { describe, expect, it } from "vitest";
import { flatten } from "@scanlist/ts-core";
import type { FlattenedItem, ScanList } from "@scanlist/ts-core";

import {
  buildRankItems,
  docTextsOf,
  evaluateTick,
  formatScore,
  heroStatus,
  missingItemVectors,
  sourceChips,
  toRows,
} from "../ranking";
import type { QueryPool } from "../pool";

/** 256-d basis vector: `components[i] = value`. */
function vec(components: Record<number, number>): number[] {
  const out = new Array<number>(256).fill(0);
  for (const [index, value] of Object.entries(components)) out[Number(index)] = value;
  return out;
}

/** A unit query that scores `cos` against basis vector `e0` and `sqrt(1-cos²)` against `e1`. */
function towards(cos: number, axis = 0): number[] {
  const rest = Math.sqrt(Math.max(0, 1 - cos * cos));
  return vec({ [axis]: cos, [axis === 0 ? 1 : 0]: rest });
}

function makeList(title: string, sectionItems: string[]): ScanList {
  return { title, sections: [{ name: "Shop", items: sectionItems.map((name) => ({ name })) }] };
}

const list = makeList("Test", ["Milk", "Bread"]);
const items: FlattenedItem[] = flatten(list);
const milk = items[0] as FlattenedItem;
const bread = items[1] as FlattenedItem;

const itemVectors = new Map<string, number[]>([
  [milk.id, vec({ 0: 1 })],
  [bread.id, vec({ 1: 1 })],
]);

describe("buildRankItems", () => {
  it("attaches found vectors and leaves missing ones null (RANK.md §8 defers the tick)", () => {
    const rankItems = buildRankItems(items, new Map([[milk.id, vec({ 0: 1 })]]));
    expect(rankItems[0]?.vec).toEqual(vec({ 0: 1 }));
    expect(rankItems[1]?.vec).toBeNull();
    expect(missingItemVectors(items, new Map([[milk.id, vec({ 0: 1 })]]))).toEqual([bread.id]);
  });

  it("docTextsOf follows FLATTEN.md order", () => {
    expect(docTextsOf(items)).toEqual(["Milk; Shop", "Bread; Shop"]);
  });
});

describe("evaluateTick — hero gates are ts-core's", () => {
  it("without any query the output is unranked and the hero is null", () => {
    const output = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map(),
      texts: [],
      imageVectors: [],
      prev: null,
      barcodeName: null,
    });
    expect(output.ranked).toBe(false);
    expect(output.topId).toBeNull();
    expect(toRows(output, items).rows.map((row) => row.isHero)).toEqual([false, false]);
  });

  it("a decisive text match becomes the hero", () => {
    const output = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map([
        ["Milk", vec({ 0: 1 })],
        ["Bread", vec({ 0: 0.5, 1: 0.5 })],
      ]),
      texts: ["Milk", "Bread"],
      imageVectors: [],
      prev: null,
      barcodeName: null,
    });
    expect(output.topId).toBe(milk.id);
    const table = toRows(output, items);
    expect(table.hero?.name).toBe("Milk");
    expect(table.rows[0]?.isHero).toBe(true);
  });

  it("an ambiguous margin yields topId null while entries keep the full ranked order", () => {
    // 0.80 vs 0.78: margin 0.02 < MARGIN_TEXT 0.05 and both clear the 0.79 floor.
    const output = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map([["query", vec({ 0: 0.8, 1: 0.78 })]]),
      texts: ["query"],
      imageVectors: [],
      prev: null,
      barcodeName: null,
    });
    expect(output.ranked).toBe(true);
    expect(output.topId).toBeNull();
    const table = toRows(output, items);
    expect(table.hero).toBeNull();
    expect(table.rows.map((row) => row.name)).toEqual(["Milk", "Bread"]);
  });

  it("below the no-match floor yields no hero", () => {
    const output = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map([["query", vec({ 0: 0.4, 1: 0.1 })]]),
      texts: ["query"],
      imageVectors: [],
      prev: null,
      barcodeName: null,
    });
    expect(output.topId).toBeNull();
    expect(toRows(output, items).hero).toBeNull();
  });

  it("an image-driven hero needs barcode accept-list confirmation (RANK.md §6.3)", () => {
    const image = [vec({ 0: 1 })];
    const without = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map(),
      texts: [],
      imageVectors: image,
      prev: null,
      barcodeName: null,
    });
    expect(without.topId).toBeNull();

    const confirmed = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map(),
      texts: [],
      imageVectors: image,
      prev: null,
      barcodeName: "Milk",
    });
    expect(confirmed.topId).toBe(milk.id);

    const wrongProduct = evaluateTick({
      items,
      itemVectors,
      textVectors: new Map(),
      texts: [],
      imageVectors: image,
      prev: null,
      barcodeName: "Nutella",
    });
    expect(wrongProduct.topId).toBeNull();
  });

  it("keeps a sticky hero through hysteresis when a challenger is inside the dead band", () => {
    // Both items are confirmed by one barcode name that hits both aliases, so the image guard is
    // satisfied and only hysteresis/margin decide. Tick 1: Milk ahead.
    const aliased: ScanList = {
      title: "Aliased",
      sections: [
        {
          name: "Shop",
          items: [
            { name: "Milk", aliases: ["Dairy pick"] },
            { name: "Bread", aliases: ["Dairy pick"] },
          ],
        },
      ],
    };
    const aliasedItems = flatten(aliased);
    const [aMilk, aBread] = aliasedItems as [FlattenedItem, FlattenedItem];
    const vectors = new Map<string, number[]>([
      [aMilk.id, vec({ 0: 1 })],
      [aBread.id, vec({ 1: 1 })],
    ]);

    const first = evaluateTick({
      items: aliasedItems,
      itemVectors: vectors,
      textVectors: new Map(),
      texts: [],
      imageVectors: [towards(0.95, 0), towards(0.9, 1)],
      prev: null,
      barcodeName: "Dairy pick",
    });
    expect(first.topId).toBe(aMilk.id);

    // Tick 2: Bread is now ahead by 0.005 after EMA smoothing (1.07 vs 1.065, boost included) —
    // inside HYSTERESIS 0.02, so the hero stays Milk instead of flipping on noise.
    const second = evaluateTick({
      items: aliasedItems,
      itemVectors: vectors,
      textVectors: new Map(),
      texts: [],
      imageVectors: [towards(0.88, 0), towards(0.94, 1)],
      prev: first,
      barcodeName: "Dairy pick",
    });
    expect(second.topId).toBe(aMilk.id);
    // ...but the order is the fresh ranking: the hero is pinned to the front by rank().
    expect(second.entries[0]?.id).toBe(aMilk.id);
    expect((second.entries[1]?.smoothed ?? 0)).toBeGreaterThan(second.entries[0]?.smoothed ?? 1);
  });
});

describe("toRows", () => {
  it("marks exactly the topId as hero and keeps scores/done from the output", () => {
    const doneList: ScanList = makeList("Done", ["Milk", "Bread"]);
    const doneItems = flatten(doneList);
    (doneList.sections[0]?.items?.[1] as { done?: boolean }).done = true;
    const flatDone = flatten(doneList);

    const output = evaluateTick({
      items: flatDone,
      itemVectors: new Map([[doneItems[0]!.id, vec({ 0: 1 })]]),
      textVectors: new Map([["Milk", vec({ 0: 1 })]]),
      texts: ["Milk"],
      imageVectors: [],
      prev: null,
      barcodeName: null,
    });

    const table = toRows(output, flatDone);
    expect(table.rows.map((row) => row.done)).toEqual([false, true]);
    expect(table.hero?.id).toBe(doneItems[0]?.id);
    expect(table.rows.filter((row) => row.isHero)).toHaveLength(1);
  });
});

describe("source chips + status copy", () => {
  const pool: QueryPool = {
    barcode: { barcode: "3017620422003", at: 1, text: "Nutella", state: "found" },
    texts: ["Nutella", "Milk"],
    images: [{ vector: [1], capturedAt: 1 }],
    droppedOcrLines: 0,
    liveOcrLines: 1,
    barcodeInPool: true,
  };

  it("lights the chips that have live evidence", () => {
    const chips = sourceChips(pool, 16);
    const byKey = new Map(chips.map((chip) => [chip.key, chip]));
    expect(byKey.get("barcode")).toMatchObject({ active: true, detail: "3017620422003" });
    expect(byKey.get("off")).toMatchObject({ active: true, detail: "found" });
    expect(byKey.get("ocr")).toMatchObject({ active: true, detail: "1 line" });
    expect(byKey.get("image")).toMatchObject({ active: true, detail: "1 frame" });
    expect(byKey.get("queries")).toMatchObject({ active: true, detail: "2/16" });
  });

  it("is honest when nothing is live", () => {
    const empty: QueryPool = {
      barcode: null,
      texts: [],
      images: [],
      droppedOcrLines: 0,
      liveOcrLines: 0,
      barcodeInPool: false,
    };
    const chips = sourceChips(empty, 16);
    expect(chips.every((chip) => !chip.active)).toBe(true);
    expect(chips.find((chip) => chip.key === "off")?.detail).toBe("—");
  });

  it("explains the null hero instead of faking one", () => {
    expect(heroStatus(null, false)).toContain("Point the camera");
    expect(heroStatus(null, true)).toContain("Nothing is a confident match");
    expect(heroStatus({ id: "x", name: "Milk", amount: "", note: null, done: false, score: 0.83, isHero: true }, true)).toContain(
      "0.83",
    );
  });

  it("formats scores with two decimals", () => {
    expect(formatScore(0.8349)).toBe("0.83");
    expect(formatScore(null)).toBe("—");
    expect(formatScore(Number.NaN)).toBe("—");
  });
});
