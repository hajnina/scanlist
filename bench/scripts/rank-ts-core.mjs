#!/usr/bin/env node
/**
 * X1 — rank() latency for 200 items on the **shared ts-core** ranker.
 *
 * `shared/ts-core` is the ranker that BOTH the RN track (`apps/rn/src/list/core.ts`) and the web
 * frontend (`@scanlist/ts-core` -> shared/ts-core/src/index.ts) import verbatim, so one measurement
 * is reported twice: as `rn.json` (the ranker RN ships) and as `web.json` (the ranker the browser
 * ships). No metro/jest/browser needed — this is the pure ranker, which is exactly the part the card
 * asks to time.
 *
 * How: bundle the TS source to ESM with the bench-local esbuild (no build of any app track, no
 * node_modules in apps/), then run rank() in a tight loop over the generated 200-item fixture.
 *
 *   node bench/scripts/make-fixture.mjs           # writes bench/.cache/rank200.txt
 *   node bench/scripts/rank-ts-core.mjs           # writes bench/results/fragments/rank-ts-core.json
 *
 * Both are called by scripts/run-all.sh; the README has the one-liners.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, "..");
const REPO = resolve(BENCH, "..");
const CACHE = resolve(BENCH, ".cache");
const require = createRequire(resolve(BENCH, "package.json"));

const ITERATIONS = Number(process.env.X1_ITERATIONS ?? "300");
const WARMUP = Number(process.env.X1_WARMUP ?? "50");

/** Nearest-rank percentile (index = ceil(p/100 * n) - 1) on an ascending copy. Documented in README. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1],
    mean: sum / s.length,
    unit: "ms",
  };
}

export function readFixture() {
  const path = resolve(CACHE, "rank200.txt");
  if (!existsSync(path)) throw new Error(`missing ${path} — run: node bench/scripts/make-fixture.mjs`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const header = lines[0].split(/\s+/);
  const meta = Object.fromEntries(header.slice(1).map((kv) => kv.split("=")));
  const items = [];
  const text = [];
  const image = [];
  for (const line of lines.slice(1)) {
    const parts = line.split("|");
    if (parts[0] === "ITEM") {
      const [, id, order, done, name, aliases, vec] = parts;
      items.push({
        id,
        order: Number(order),
        done: done === "1",
        name,
        aliases: aliases ? aliases.split(";").filter(Boolean) : [],
        vec: vec.split(",").map(Number),
      });
    } else if (parts[0] === "TEXT") {
      text.push(parts[1].split(",").map(Number));
    } else if (parts[0] === "IMAGE") {
      image.push(parts[1].split(",").map(Number));
    }
  }
  return { meta, items, text, image };
}

async function bundleTsCore() {
  const { build } = await import(require.resolve("esbuild"));
  const outfile = resolve(CACHE, "ts-core.mjs");
  mkdirSync(CACHE, { recursive: true });
  const t0 = process.hrtime.bigint();
  const result = await build({
    entryPoints: [resolve(REPO, "shared/ts-core/src/index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
    metafile: true,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  return { outfile, ms, bytes };
}

const time = (fn) => {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return [Number(process.hrtime.bigint() - t0) / 1e6, out];
};

async function main() {
  const fixture = readFixture();
  const bundle = await bundleTsCore();
  const { rank, decideTop } = await import(`${bundle.outfile}?v=${Date.now()}`);

  // Ring buffer conversion: ts-core wants FlattenedItem + vec; the fixture has no tree, so path is
  // a synthetic section name and index/order come from the fixture.
  const items = fixture.items.map((it) => ({
    id: it.id,
    name: it.name,
    amount: null,
    unit: null,
    note: null,
    aliases: it.aliases,
    done: it.done,
    path: [`Section ${Math.floor(it.order / 10) + 1}`],
    pathText: `Section ${Math.floor(it.order / 10) + 1}`,
    index: it.order % 10,
    order: it.order,
    vec: it.vec,
  }));
  const queries = { text: fixture.text, image: fixture.image };

  // Phase 0 — cold: bundle + module load + first tick (this is the "JIT-cold" datum).
  const [coldMs, coldOut] = time(() => rank(items, queries, null));

  // Phase 1 — warmup, carrying the state forward exactly like a live tick loop (EMA path live).
  let state = coldOut.state;
  for (let i = 0; i < WARMUP; i++) state = rank(items, queries, state).state;

  // Phase 2 — measured loop.
  const rankSamples = [];
  const decideSamples = [];
  let lastEntries = 0;
  let lastTop3 = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const [ms, out] = time(() => rank(items, queries, state));
    rankSamples.push(ms);
    state = out.state;
    lastEntries = out.entries.length;
    lastTop3 = out.entries
      .filter((e) => !e.done)
      .slice(0, 3)
      .map((e) => ({ id: e.id, smoothed: e.smoothed }));
    const sorted = out.entries
      .filter((e) => !e.done)
      .map((e, idx) => ({ id: e.id, order: idx, raw: e.raw ?? 0, smoothed: e.smoothed ?? 0 }));
    const [dms] = time(() => decideTop(sorted, state.topId, new Set()));
    decideSamples.push(dms);
  }

  const fragments = resolve(BENCH, "results/fragments");
  mkdirSync(fragments, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    implementation: "shared/ts-core (TypeScript, ESM bundle via esbuild)",
    provenance: {
      source: "shared/ts-core/src/rank.ts",
      consumedBy: ["apps/rn/src/list/core.ts (RN imports the same module)", "apps/web/frontend/src (tsconfig paths alias)"],
      fixture: "bench/.cache/rank200.txt (generated by bench/scripts/make-fixture.mjs)",
      runner: `node ${process.version} on linux/aarch64, single thread, no JIT flags`,
    },
    environment: { node: process.version, iterations: ITERATIONS, warmup: WARMUP, items: items.length, dims: 256 },
    measurements: {
      "rank200": stats(rankSamples),
      "decideTop200": stats(decideSamples),
      "bundle.tsCoreBytes": { status: "measured", bytes: bundle.bytes, ms: bundle.ms },
      "rank200.coldFirstTick": { status: "measured", ms: coldMs },
    },
    // Cross-implementation sanity: the ts-core / Kotlin / oracle runs must agree on the hero id for
    // this workload, otherwise the three latency numbers would not describe the same computation.
    sanity: { topId: state.topId, entries: lastEntries, top3: lastTop3 },
  };
  writeFileSync(resolve(fragments, "rank-ts-core.json"), `${JSON.stringify(payload, null, 2)}\n`);

  const s = stats(rankSamples);
  console.log(
    `ts-core rank(200 items, 16 text + 1 image queries): p50 ${s.p50.toFixed(3)} ms, p95 ${s.p95.toFixed(3)} ms ` +
      `(min ${s.min.toFixed(3)}, max ${s.max.toFixed(3)}, n=${s.n}); decideTop p95 ${stats(decideSamples).p95.toFixed(3)} ms`,
  );
  console.log(`-> bench/results/fragments/rank-ts-core.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
