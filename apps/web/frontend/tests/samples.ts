/**
 * Shared fixtures, imported as raw text (same approach as shared/ts-core/tests/fixtures.ts).
 *
 * The tests read the repo-level fixtures directly instead of copying them, so a change in
 * shared/spec or shared/fixtures fails this suite immediately. `?raw` keeps TypeScript from having
 * to infer an 850 KB JSON literal.
 */

import goldenRaw from "../../../../shared/fixtures/golden.json?raw";
import aliasesRaw from "../../../../shared/spec/samples/aliases-es-cz.json?raw";
import deepNestingRaw from "../../../../shared/spec/samples/deep-nesting.json?raw";
import stringAmountsRaw from "../../../../shared/spec/samples/string-amounts.json?raw";
import vanWeeklyRaw from "../../../../shared/spec/samples/van-weekly.json?raw";
import type { FlattenedItem } from "@scanlist/ts-core";

export interface GoldenList {
  id: string;
  source: string;
  title: string;
  itemCount: number;
  items: FlattenedItem[];
  itemVectors: Record<string, number[]>;
}

export interface GoldenFixture {
  version: number;
  generated: string;
  lists: GoldenList[];
  queries: Array<{ id: string; kind: "text" | "image"; list: string }>;
}

export const golden = JSON.parse(goldenRaw) as GoldenFixture;

export const goldenListsById = new Map(golden.lists.map((list) => [list.id, list]));

/** The four real sample files, keyed by file stem (which is also the golden list id). */
export const samples: ReadonlyArray<{ name: string; text: string; itemCount: number }> = [
  { name: "aliases-es-cz", text: aliasesRaw, itemCount: 13 },
  { name: "deep-nesting", text: deepNestingRaw, itemCount: 10 },
  { name: "string-amounts", text: stringAmountsRaw, itemCount: 11 },
  { name: "van-weekly", text: vanWeeklyRaw, itemCount: 10 },
];
