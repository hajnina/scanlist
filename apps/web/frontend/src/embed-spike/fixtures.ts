/**
 * Fixture loading for the spike page (dev server only).
 *
 * The JSON and JPEGs come from `shared/` through Vite (`?raw` / `?url` globs): the page always
 * embeds the SAME inputs the Python oracle embedded, so parity is a like-for-like comparison and
 * nothing is copied into this package. Images never leave the repo either — the model weights are
 * the only thing that is downloaded, and they go to the browser cache, not git.
 */

import type { FlattenedItem } from "@scanlist/ts-core";

import { prefixesFromSpec } from "./budget";
import type { Prefixes } from "./budget";
import type { GoldenQuery } from "./harness";

const goldenRaw = import.meta.glob("../../../../../shared/fixtures/golden.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const promptsRaw = import.meta.glob("../../../../../shared/spec/prompts.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const photoUrls = import.meta.glob("../../../../../shared/fixtures/photos/*.jpg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface GoldenList {
  id: string;
  items: FlattenedItem[];
  itemVectors: Record<string, number[]>;
}

interface GoldenFile {
  generated: string;
  model: { id: string; hfRepo: string; revision: string; dtype: string };
  lists: GoldenList[];
  queries: (GoldenQuery & { file?: string; text?: string })[];
}

function readSingle(map: Record<string, string>, what: string): string {
  const values = Object.values(map);
  if (values.length !== 1 || values[0] === undefined) {
    throw new Error(`expected exactly one ${what} fixture, found ${values.length}`);
  }
  return values[0];
}

export function loadPrompts(): Prefixes {
  return prefixesFromSpec(JSON.parse(readSingle(promptsRaw, "prompts.json")));
}

export function loadGolden(): GoldenFile {
  return JSON.parse(readSingle(goldenRaw, "golden.json")) as GoldenFile;
}

/** Absolute-ish dev URL for a golden fixture photo, e.g. `.../milk.jpg`. */
export function photoUrl(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const match = Object.entries(photoUrls).find(([key]) => key.endsWith(`/${base}`));
  if (!match) throw new Error(`no Vite URL for fixture photo ${file}`);
  return match[1] as string;
}

export interface ImageSpec {
  id: string;
  url: string;
  vector?: number[];
  expectedTop3?: string[];
  file: string;
}

export interface Scenario {
  prompts: Prefixes;
  listId: string;
  items: FlattenedItem[];
  itemVectors: Record<string, number[]>;
  textQueries: GoldenQuery[];
  images: ImageSpec[];
  golden: { generated: string; modelId: string; revision: string; dtype: string };
}

export interface ScenarioOptions {
  /** Which golden list supplies the item docs (default: the 10-item `van-weekly`). */
  listId?: string;
  /** Cap the number of image queries used (default 3; the batch trap needs ≥2). */
  maxImages?: number;
}

/**
 * The scenario the spike measures: one golden list's items (text parity + real rank() top-1) and
 * the golden text/image queries that target that list. Image queries are filtered to the first
 * `maxImages` product photos so a full run stays inside one batch.
 */
export function buildScenario(options: ScenarioOptions = {}): Scenario {
  const golden = loadGolden();
  const listId = options.listId ?? "van-weekly";
  const list = golden.lists.find((candidate) => candidate.id === listId);
  if (!list) throw new Error(`golden.json has no list ${JSON.stringify(listId)}`);

  const textQueries = golden.queries
    .filter((query) => query.kind === "text" && (query as { list?: string }).list === listId)
    .map((query) => ({ ...query, text: query.text ?? "" }));

  const maxImages = options.maxImages ?? 3;
  const images = golden.queries
    .filter((query) => query.kind === "image" && typeof query.file === "string")
    .slice(0, maxImages)
    .map((query) => ({
      id: query.id,
      file: query.file as string,
      url: photoUrl(query.file as string),
      vector: query.vector,
      expectedTop3: query.expectedTop3,
    }));

  return {
    prompts: loadPrompts(),
    listId,
    items: list.items,
    itemVectors: list.itemVectors,
    textQueries,
    images,
    golden: {
      generated: golden.generated,
      modelId: golden.model.id,
      revision: golden.model.revision,
      dtype: golden.model.dtype,
    },
  };
}
