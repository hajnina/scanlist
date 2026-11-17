/**
 * Card C5 — `itemById` pairs the ranker's ids with C2's *original* nested items.
 *
 * This is a correctness bridge, not a convenience: ticking a `FlattenedItem` copy would persist
 * nothing. The pairing is pinned against `flatten()` on every repo sample so a traversal change in
 * ts-core fails here instead of silently ticking the wrong row.
 */

import { describe, expect, it } from "vitest";
import { flatten, parseList } from "@scanlist/ts-core";

import { itemById, originalItems } from "../items";
import { samples } from "../../../../tests/samples";

describe("itemById", () => {
  it("returns the original objects in flatten order for every sample", () => {
    for (const sample of samples) {
      const parsed = parseList(sample.text);
      expect(parsed.ok, sample.name).toBe(true);
      if (!parsed.ok) continue;

      const flat = flatten(parsed.list);
      const originals = originalItems(parsed.list);
      expect(originals, sample.name).toHaveLength(flat.length);

      const byId = itemById(parsed.list);
      expect([...byId.keys()], sample.name).toEqual(flat.map((item) => item.id));
      flat.forEach((item, index) => {
        expect(byId.get(item.id), sample.name).toBe(originals[index]);
        expect(byId.get(item.id)?.name, sample.name).toBe(item.name);
      });
    }
  });

  it("hands back the live object, so mutating it is what flatten() will see next", () => {
    const parsed = parseList(JSON.stringify({ title: "T", sections: [{ name: "S", items: [{ name: "Milk" }] }] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const flat = flatten(parsed.list);
    const target = itemById(parsed.list).get(flat[0]!.id);
    expect(target).toBe(parsed.list.sections[0]?.items?.[0]);
    if (target !== undefined) target.done = true;
    expect(flatten(parsed.list)[0]?.done).toBe(true);
  });

  it("handles a deep tree in the same order as the flattener", () => {
    const list = {
      title: "Deep",
      sections: [
        {
          name: "A",
          items: [{ name: "a1" }, { name: "a2" }],
          sections: [{ name: "A1", items: [{ name: "a11" }], sections: [{ name: "A11", items: [{ name: "a111" }] }] }],
        },
        { name: "B", items: [{ name: "b1" }] },
      ],
    };
    const flat = flatten(list);
    const originals = originalItems(list);
    expect(originals.map((item) => item.name)).toEqual(flat.map((item) => item.name));
    expect(flat.map((item) => item.pathText)).toEqual([
      "A",
      "A",
      "A > A1",
      "A > A1 > A11",
      "B",
    ]);
  });
});
