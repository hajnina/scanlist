#!/usr/bin/env node
/**
 * X1 — generate the deterministic 200-item rank fixture that all three rank benchmarks read.
 *
 * Why a generated fixture (and not `shared/fixtures/golden.json` directly): the golden lists are
 * the *parity* corpus (10–44 items, hand-written), and X1's card asks for **200 items** — a realistic
 * long list. Regenerating a list from the golden corpus keeps the vectors real (they are actual
 * EmbeddingGemma 2 outputs, already truncated + L2-normalised at 256-d) while the names flatten to a
 * plain 200-row list. No model call, no randomness: cycling the 88 pinned item vectors makes the run
 * bit-identical on every machine, which is what lets the ts-core / Kotlin / oracle numbers be compared.
 *
 * Output: bench/.cache/rank200.txt (gitignored), a `|`-separated text file because the Kotlin driver
 * has no JSON parser on its classpath (see README "why a text fixture").
 *
 *   line 0        : `scanlist-rank-fixture <version> items=<n> dims=<d> text=<t> image=<i>`
 *   line 1..      : `ITEM|<id>|<order>|<done 0|1>|<name>|<alias1;alias2>|<v0,v1,...>`
 *   then          : `TEXT|<v0,v1,...>`   (16 of them — RANK.md §2.2 MAX_TEXT_QUERIES)
 *   then          : `IMAGE|<v0,v1,...>`  (1)
 *
 * Usage: node bench/scripts/make-fixture.mjs [--items 200] [--out path]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const GOLDEN = resolve(REPO, "shared/fixtures/golden.json");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const ITEMS = Number(opt("items", "200"));
const OUT = resolve(opt("out", resolve(REPO, "bench/.cache/rank200.txt")));

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const dims = golden.dims.active;

/** All pinned item vectors, in golden order, flattened across lists. */
const itemVectors = [];
for (const list of golden.lists) {
  for (const item of list.items) {
    const v = list.itemVectors[item.id];
    if (Array.isArray(v)) itemVectors.push({ vec: v, name: item.name, aliases: item.aliases ?? [] });
  }
}
if (itemVectors.length < 8) throw new Error(`need item vectors, got ${itemVectors.length}`);

/** 16 text queries + 1 image query, exactly as the golden parity contract uses them. */
const textQueries = golden.queries.filter((q) => q.kind === "text").slice(0, 16);
const imageQueries = golden.queries.filter((q) => q.kind === "image").slice(0, 1);
if (textQueries.length !== 16) throw new Error(`expected 16 text queries, got ${textQueries.length}`);
if (imageQueries.length !== 1) throw new Error(`expected 1 image query, got ${imageQueries.length}`);

const fmt = (v) => v.map((x) => x.toPrecision(17)).join(",");

/**
 * Cycling 88 pinned vectors over 200 items would give ~2.5 items the *same* embedding, and identical
 * top scores then trip the §6.2 margin gate for the whole list (no hero at all) — an artefact, not a
 * workload. A real 200-item list has no byte-identical products. So each item gets one small
 * deterministic basis-vector offset (0.08 at index i % dims, then re-normalised): geometry stays the
 * real EmbeddingGemma 2 corpus, but all 200 vectors are distinct and the hero path stays live.
 */
function distinct(vec, i, d) {
  const out = vec.slice();
  out[i % d] += 0.08;
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  return out.map((x) => x / norm);
}

// 20 sections x 10 items. `done` on every 13th item, like a real list with a collapsed Done group.
const lines = [`scanlist-rank-fixture 1 items=${ITEMS} dims=${dims} text=${textQueries.length} image=${imageQueries.length}`];
for (let i = 0; i < ITEMS; i++) {
  const src = itemVectors[i % itemVectors.length];
  const section = Math.floor(i / 10);
  const name = `${src.name} ${section + 1}`; // unique names: barcode/media boost paths stay live
  const id = `x1:${String(i).padStart(4, "0")}`;
  const done = i % 13 === 12 ? 1 : 0;
  lines.push(`ITEM|${id}|${i}|${done}|${name}|${src.aliases.join(";")}|${fmt(distinct(src.vec, i, dims))}`);
}
for (const q of textQueries) lines.push(`TEXT|${fmt(q.vector)}`);
for (const q of imageQueries) lines.push(`IMAGE|${fmt(q.vector)}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(
  `wrote ${OUT}: ${ITEMS} items, ${dims}-d, ${textQueries.length} text + ${imageQueries.length} image queries ` +
    `(from ${GOLDEN.replace(`${REPO}/`, "")})`,
);
