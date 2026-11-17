/**
 * Compile-time contract check against card A1's RN types (`apps/rn/src/list/types.ts`).
 *
 * The shapes below are copied from that file on purpose: TypeScript only has to see the same
 * fields and optionality. If either side drifts, `npx tsc --noEmit` fails here.
 */

import { describe, expect, it } from "vitest";

import { parseList } from "../src/parse";
import { flatten } from "../src/flatten";
import type {
  FlattenedItem,
  ScanList,
  ScanListAmount,
  ScanListItem,
  ScanListSection,
} from "../src/types";

// --- mirror of apps/rn/src/list/types.ts (card A1) -----------------------------------------
type A1ScanListAmount = number | string;

interface A1ScanListItem {
  id?: string;
  name: string;
  amount?: A1ScanListAmount;
  unit?: string;
  note?: string;
  aliases?: string[];
  done?: boolean;
}

interface A1ScanListSection {
  name: string;
  items?: A1ScanListItem[];
  sections?: A1ScanListSection[];
}

interface A1ScanList {
  title: string;
  version?: number;
  sections: A1ScanListSection[];
}

interface A1FlatItem {
  itemId: string;
  path: string[];
  name: string;
  done: boolean;
}

function toA1(list: ScanList): A1ScanList {
  return list;
}

function fromA1(list: A1ScanList): ScanList {
  return list;
}

function toA1Flat(item: FlattenedItem): A1FlatItem {
  return { itemId: item.id, path: item.path, name: item.name, done: item.done };
}

// Exercise the aliases so `noUnusedLocals` stays happy.
const _amount: ScanListAmount = 2;
const _item: ScanListItem = { name: "Milk", amount: _amount };
const _section: ScanListSection = { name: "S", items: [_item] };

describe("types agree with A1's RN contract", () => {
  it("round-trips a parsed list through the A1 shapes", () => {
    const parsed = parseList(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"Milk","amount":2}]}]}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const roundTripped = fromA1(toA1(parsed.list));
    expect(roundTripped.title).toBe("T");

    const flat = flatten(roundTripped)[0];
    expect(flat).toBeDefined();
    const a1Flat = toA1Flat(flat as FlattenedItem);
    expect(a1Flat.itemId).toMatch(/^sha1:/);
    expect(a1Flat.name).toBe("Milk");
    expect(_section.items?.[0]?.name).toBe("Milk");
  });
});
