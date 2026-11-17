/**
 * Export round-trip (LIST.md §7): import -> tick -> export must flatten to the same items as the
 * import apart from the `done` flags, and export -> parse -> export must be a fixed point.
 *
 * Runs over the four real shared samples, so the guarantee is anchored to the same fixtures the
 * golden test uses.
 */

import { describe, expect, it } from "vitest";
import { flatten, parseList } from "@scanlist/ts-core";
import type { ScanListSection } from "@scanlist/ts-core";

import { exportFileName, exportJson, toExportDocument } from "../src/core/exportDoc";
import { samples } from "./samples";

describe("export document", () => {
  for (const sample of samples) {
    it(`round-trips ${sample.name} through parseList`, () => {
      const imported = parseList(sample.text);
      expect(imported.ok, imported.ok ? "" : imported.errors.join("; ")).toBe(true);
      if (!imported.ok) return;

      const exported = exportJson(imported.list);
      const reimported = parseList(exported);
      expect(reimported.ok, reimported.ok ? "" : reimported.errors.join("; ")).toBe(true);
      if (!reimported.ok) return;

      // Same flattened items, in order, with the same ids (FLATTEN.md §2/§3).
      expect(flatten(reimported.list)).toEqual(flatten(imported.list));

      // Exporting again is byte-identical: the export format is a fixed point.
      expect(exportJson(reimported.list)).toBe(exported);
    });

    it(`keeps every tick in ${sample.name}`, () => {
      const imported = parseList(sample.text);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;

      const before = flatten(imported.list);
      const target = before.find((item) => !item.done);
      expect(target, "every sample has an unticked item").toBeDefined();
      if (target === undefined) return;

      // Tick one item the same way the UI does: mutate `done` on the first unticked tree item.
      function tickFirstUnticked(section: ScanListSection): boolean {
        for (const item of section.items ?? []) {
          if (item.done !== true) {
            item.done = true;
            return true;
          }
        }
        for (const child of section.sections ?? []) {
          if (tickFirstUnticked(child)) return true;
        }
        return false;
      }
      let ticked = false;
      for (const section of imported.list.sections) {
        if (tickFirstUnticked(section)) {
          ticked = true;
          break;
        }
      }
      expect(ticked).toBe(true);

      const reimported = parseList(exportJson(imported.list));
      expect(reimported.ok).toBe(true);
      if (!reimported.ok) return;

      const after = flatten(reimported.list);
      expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
      // Exactly one more tick, and it is the item we ticked (ids are stable across the round trip).
      const doneBefore = before.filter((item) => item.done).map((item) => item.id);
      const doneAfter = after.filter((item) => item.done).map((item) => item.id);
      expect(doneAfter).toHaveLength(doneBefore.length + 1);
      expect(doneAfter).toContain(target.id);
      for (const id of doneBefore) expect(doneAfter).toContain(id);
    });
  }

  it("omits defaults but keeps every non-default field", () => {
    const parsed = parseList(
      JSON.stringify({
        title: "Van weekly shop",
        sections: [
          {
            name: "Fresh",
            items: [
              { id: " bananas ", name: "Bananas", amount: 6 },
              { name: "Oat milk", amount: "2 cartons", unit: "l", note: "barista", aliases: ["bebida de avena"], done: true },
              { name: "Bread", amount: "  ", aliases: [] },
            ],
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const document = toExportDocument(parsed.list) as {
      title: string;
      version: number;
      sections: Array<{ name: string; items?: Array<Record<string, unknown>> }>;
    };
    expect(document.title).toBe("Van weekly shop");
    expect(document.version).toBe(1);
    const items = document.sections[0]?.items ?? [];
    expect(items[0]).toEqual({ id: "bananas", name: "Bananas", amount: 6 });
    expect(items[1]).toEqual({
      name: "Oat milk",
      amount: "2 cartons",
      unit: "l",
      note: "barista",
      aliases: ["bebida de avena"],
      done: true,
    });
    expect(items[2]).toEqual({ name: "Bread" });
  });

  it("keeps an empty list valid (LIST.md §1: nothing to buy)", () => {
    const parsed = parseList('{"title": "Empty", "sections": []}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reimported = parseList(exportJson(parsed.list));
    expect(reimported.ok).toBe(true);
    if (!reimported.ok) return;
    expect(reimported.list.sections).toEqual([]);
  });

  it("names the download after the title", () => {
    expect(exportFileName("Van weekly shop")).toBe("van-weekly-shop.json");
    expect(exportFileName("  Nákup – 17. 11. ")).toBe("nakup-17-11.json");
    expect(exportFileName("***")).toBe("scanlist.json");
    expect(exportFileName("")).toBe("scanlist.json");
  });
});
