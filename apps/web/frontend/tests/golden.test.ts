/**
 * Card C2 done-when, part 1: replay the S3 golden fixture through the shared core *from the web app*.
 *
 * This is not a second copy of shared/ts-core/tests/golden.test.ts — it proves the wiring the web app
 * actually ships: the `@scanlist/ts-core` import alias, the `?raw` shared-fixture import, and the
 * `parseList` -> `flatten` -> `docText` chain. All four real samples must reproduce the Python
 * oracle's flattened items byte for byte (ids/order/fields) and their embedding text byte for byte.
 *
 * `golden.json` does not store `docText` (FLATTEN.md §1 key set), so the expected strings are
 * recomposed here from the oracle's own `name`/`aliases`/`path` fields using the FLATTEN.md §4
 * separators — an independent input, not a self-comparison.
 */

import { describe, expect, it } from "vitest";
import { docText, flatten, parseList } from "@scanlist/ts-core";
import type { FlattenedItem } from "@scanlist/ts-core";

import { golden, goldenListsById, samples } from "./samples";

function expectedDocText(item: FlattenedItem): string {
  const parts: string[] = [item.name];
  if (item.aliases.length > 0) parts.push(item.aliases.join(", "));
  if (item.path.length > 0) parts.push(item.path.join(" > "));
  return parts.join("; ").trim();
}

describe("golden.json replay through @scanlist/ts-core", () => {
  it("has the fixture the web build depends on", () => {
    expect(golden.version).toBe(1);
    expect(golden.lists.map((list) => list.id)).toEqual([
      "van-weekly",
      "string-amounts",
      "aliases-es-cz",
      "deep-nesting",
      "photo-corpus",
    ]);
    expect(samples.reduce((sum, sample) => sum + sample.itemCount, 0)).toBe(44);
  });

  for (const sample of samples) {
    it(`flattens ${sample.name} exactly like the oracle`, () => {
      const parsed = parseList(sample.text);
      expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
      if (!parsed.ok) return;

      const flat = flatten(parsed.list);
      const expected = goldenListsById.get(sample.name);
      expect(expected, `golden.json has no list ${sample.name}`).toBeDefined();
      if (expected === undefined) return;

      expect(flat).toHaveLength(sample.itemCount);
      expect(flat).toHaveLength(expected.itemCount);

      // ids, byte for byte (JSON string compare, so order matters).
      expect(JSON.stringify(flat.map((item) => item.id))).toBe(
        JSON.stringify(expected.items.map((item) => item.id)),
      );
      // Every field, including pathText/index/order.
      expect(flat).toEqual(expected.items);

      // docText, byte for byte, against the strings implied by the oracle's own fields.
      expect(JSON.stringify(flat.map((item) => docText(item)))).toBe(
        JSON.stringify(expected.items.map(expectedDocText)),
      );
    });
  }

  it("pins the FLATTEN.md §4 worked docText literals", () => {
    const byName = (sampleName: string, itemName: string): string => {
      const sample = samples.find((entry) => entry.name === sampleName);
      expect(sample).toBeDefined();
      const parsed = parseList(sample?.text ?? "");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return "";
      const item = flatten(parsed.list).find((entry) => entry.name === itemName);
      expect(item, `${itemName} not in ${sampleName}`).toBeDefined();
      return item === undefined ? "" : docText(item);
    };

    expect(byName("van-weekly", "Bananas")).toBe("Bananas; Fresh > Fruit & veg");
    expect(byName("van-weekly", "Tomatoes")).toBe("Tomatoes; tomates; Fresh > Fruit & veg");
    expect(byName("van-weekly", "Oat milk")).toBe("Oat milk; bebida de avena; Fresh > Dairy");
    expect(byName("deep-nesting", "Cumin")).toBe("Cumin; comino, kmín; Home > Kitchen > Pantry > Spices");
  });
});
