/**
 * Typed access to the repo-level fixtures (shared/fixtures + shared/spec/samples).
 *
 * The fixture is the S3 artefact produced by the S2 Python oracle; the tests import it as raw text
 * so TypeScript does not have to infer an 850 KB JSON literal and so no filesystem/node types are
 * needed (the package's only dev dependency is vitest).
 */

import goldenRaw from "../../fixtures/golden.json?raw";
import aliasesRaw from "../../spec/samples/aliases-es-cz.json?raw";
import deepNestingRaw from "../../spec/samples/deep-nesting.json?raw";
import stringAmountsRaw from "../../spec/samples/string-amounts.json?raw";
import vanWeeklyRaw from "../../spec/samples/van-weekly.json?raw";
import type { FlattenedItem } from "../src/types";

export interface GoldenList {
  id: string;
  source: string;
  title: string;
  itemCount: number;
  items: FlattenedItem[];
  itemVectors: Record<string, number[]>;
}

export interface GoldenQuery {
  id: string;
  kind: "text" | "image";
  list: string;
  expect: "hit" | "nomatch";
  accept: string[];
  targetNames: string[];
  note: string;
  vector: number[];
  expectedTop3: string[];
  expectedScores: number[];
  expectedMargin: number;
  text?: string | null;
}

export interface GoldenFixture {
  version: number;
  generated: string;
  generator: string;
  model: Record<string, unknown>;
  dims: { native: number; active: number };
  prompts: Record<string, unknown>;
  contract: Record<string, string>;
  lists: GoldenList[];
  queries: GoldenQuery[];
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
