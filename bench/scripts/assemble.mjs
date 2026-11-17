#!/usr/bin/env node
/**
 * X1 — compose the four `bench/results/<track>.json` files from the measurement fragments.
 *
 * The fragments (bench/results/fragments/*.json) are what the individual scripts produce; this step
 * is the only place that decides **what a track could and could not measure**, so every `n/a` has one
 * documented reason in one file instead of being scattered across scripts. Missing fragments and
 * missing tracks degrade to `n/a` — the harness is meant to run on a partial checkout.
 *
 *   node bench/scripts/assemble.mjs            # -> bench/results/{kotlin,rn,web,oracle}.json
 *
 * Shape per track file:
 *   { generatedAt, track, implementation, provenance: [...], headline, measurements: { key: value | n/a } }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, "..");
const REPO = resolve(BENCH, "..");
const FRAG = resolve(BENCH, "results/fragments");
const OUT = resolve(BENCH, "results");

const na = (reason) => ({ status: "n/a", reason });

function fragment(name) {
  const path = resolve(FRAG, `${name}.json`);
  if (!existsSync(path)) {
    return { missing: true, reason: `fragment ${name}.json not found — run the script that writes it (see bench/README.md)` };
  }
  return { missing: false, data: JSON.parse(readFileSync(path, "utf8")) };
}

/** Pull one measurement out of a fragment, or produce an n/a that names the script to run. */
function from(frag, pick, label) {
  if (frag.missing) return na(frag.reason);
  const value = pick(frag.data);
  return value === undefined || value === null ? na(`${label} not present in the fragment`) : value;
}

const kotlinRank = fragment("rank-kotlin");
const oracleRank = fragment("rank-oracle");
const tsCoreRank = fragment("rank-ts-core");
const loc = fragment("loc");
const sizes = fragment("sizes");
const times = fragment("buildtimes");
const cold = fragment("coldstart-web");
const cost = fragment("agent-cost");

const locOf = (area) =>
  from(loc, (d) => (d.areas?.[area]?.status === "n/a" ? undefined : d.areas?.[area]), `loc area ${area}`);

const costOf = (track) =>
  from(cost, (d) => {
    const sessions = d.sessions?.tracks?.[track];
    const cards = d.cards?.[track];
    if (!sessions && !cards) return undefined;
    return {
      status: "measured",
      sessions: sessions?.sessions ?? 0,
      tokensOutput: sessions?.tokensOutput ?? 0,
      tokensInput: sessions?.tokensInput ?? 0,
      cacheRead: sessions?.cacheRead ?? 0,
      costUsd: sessions?.cost ?? 0,
      cards: cards ?? null,
      mergedPrs: d.leadLog?.mergedPrs?.[track] ?? null,
      requestChangesVerdicts: d.leadLog?.requestChangesVerdicts?.[track] ?? null,
      tokensOutputPerMergedPr: d.normalised?.[track]?.tokensOutputPerMergedPr ?? null,
      method: d.method,
      honestLimits: d.honestLimits,
    };
  }, `agent cost for ${track}`);

const buildOf = (track) =>
  from(times, (d) => {
    const t = d.tracks?.[track];
    if (!t) return undefined;
    return { status: "measured", ...t, ciJob: d.tracks?.ci?.[track] ?? null };
  }, `build times for ${track}`);

const NO_DEVICE =
  "no Android device on adb (card B0 is device-blocked), so nothing can be measured on ART/the NPU; " +
  "the number only exists once a phone is plugged in. Not a harness limitation — a missing device.";

/* ------------------------------------------------------------------ kotlin */
const kotlin = {
  generatedAt: new Date().toISOString(),
  track: "kotlin",
  implementation: "apps/kotlin — Kotlin 2.0.21 + Jetpack Compose (M3 Expressive), on-device LiteRT EmbeddingGemma 2, pure-Kotlin ranker",
  provenance: [
    "rank: bench/driver/Rank200.java against apps/kotlin/app/build/tmp/kotlin-classes/debug (JVM desktop, same code ART runs)",
    "sizes: apps/kotlin/app/build/outputs/apk/debug + CI artifact scanlist-kotlin-apk (run 44026921235, card/B6)",
    "build: ./gradlew via scripts/android-env.sh on this aarch64 laptop; CI job duration from gh api",
    "loc: bench/scripts/loc.py over apps/kotlin (excludes build/)",
    "cost: opencode session ledger + kanban/lead-log.md",
  ],
  headline:
    "Smallest APK of the two native tracks (142 MB vs RN's 291 MB) and the fastest ranker (0.66 ms p50 for 200 items) — " +
    "but every on-device latency number is still unmeasurable without the phone.",
  measurements: {
    "coldStart.listVisible": na(NO_DEVICE),
    "embed.text.p50": na(NO_DEVICE),
    "embed.image.p50": na(NO_DEVICE),
    rank200: from(kotlinRank, (d) => d.measurements?.rank200, "kotlin rank200"),
    "rank200.coldFirstTick": from(kotlinRank, (d) => d.measurements?.["rank200.coldFirstTick"], "kotlin cold first tick"),
    decideTop200: from(kotlinRank, (d) => d.measurements?.decideTop200, "kotlin decideTop200"),
    "rank200.caveat":
      "JVM desktop timing of the same Kotlin source ART runs; treat it as a lower bound for on-device rank time " +
      "(ART has no C2 JIT warmup plateau and the phone CPU is slower). The workload is identical to the ts-core and oracle runs.",
    apk: from(sizes, (d) => d.tracks?.kotlin, "kotlin APK sizes"),
    loc: locOf("kotlin"),
    buildTime: buildOf("kotlin"),
    agentCost: costOf("kotlin"),
    sanity: from(kotlinRank, (d) => d.sanity, "kotlin sanity"),
  },
};

/* ---------------------------------------------------------------------- rn */
const rn = {
  generatedAt: new Date().toISOString(),
  track: "rn",
  implementation: "apps/rn — React Native 0.88 + react-native-paper, shared ts-core ranker, on-device LiteRT via a Nitro module",
  provenance: [
    "rank: shared/ts-core/src/rank.ts (the module apps/rn/src/list/core.ts imports) — labelled ts-core, not re-implemented",
    "sizes: CI artifact scanlist-rn-apk (run 44023804443, card/A2) + a local `react-native bundle` of the same tree",
    "build: local metro/jest timings on this laptop; the APK itself is built by CI (aarch64 laptop cannot run the NDK/CMake prebuilts)",
    "loc: bench/scripts/loc.py over apps/rn (excludes node_modules, android/build)",
    "cost: opencode session ledger + kanban/lead-log.md",
  ],
  headline:
    "Biggest artifact by far (291 MB APK, 87% of it native .so files across four ABIs) and the slowest CI build (19 min), " +
    "but it reuses the shared ts-core ranker instead of porting one.",
  measurements: {
    "coldStart.listVisible": na(NO_DEVICE),
    "embed.text.p50": na(NO_DEVICE),
    "embed.image.p50": na(NO_DEVICE),
    rank200: from(tsCoreRank, (d) => d.measurements?.rank200, "ts-core rank200"),
    "rank200.coldFirstTick": from(tsCoreRank, (d) => d.measurements?.["rank200.coldFirstTick"], "ts-core cold first tick"),
    decideTop200: from(tsCoreRank, (d) => d.measurements?.decideTop200, "ts-core decideTop200"),
    "rank200.label":
      "ts-core numbers: RN does not have its own ranker, it imports shared/ts-core (apps/rn/src/list/core.ts). " +
      "Measured in node, not in Hermes — Hermes is slower on float64 loops, so treat this as a lower bound for the device.",
    apk: from(sizes, (d) => d.tracks?.rn?.apkCi, "rn APK size"),
    jsBundle: from(sizes, (d) => d.tracks?.rn?.jsBundle, "rn JS bundle size"),
    loc: locOf("rn"),
    buildTime: buildOf("rn"),
    agentCost: costOf("rn"),
    sanity: from(tsCoreRank, (d) => d.sanity, "ts-core sanity"),
  },
};

/* --------------------------------------------------------------------- web */
const PERF = "apps/web/server/PERF.md (card C3, measured 2026-11-17 on this laptop, fp32 CPU torch path)";
const web = {
  generatedAt: new Date().toISOString(),
  track: "web",
  implementation: "apps/web — Preact + @material/web PWA frontend on ts-core, Python/torch embedding server (EmbeddingGemma 2 fp32 CPU)",
  provenance: [
    `embed latency: recorded, not re-run — ${PERF}; re-running needs a ~2 GB torch venv that this laptop's disk quota does not have`,
    "cold start: measured now, real headless Chrome against apps/web/frontend/dist (bench/scripts/coldstart-web.mjs)",
    "rank: shared/ts-core/src/rank.ts — the browser imports the same module via the tsconfig/vite alias",
    "sizes: apps/web/frontend/dist from `npm run build` (tsc --noEmit && vite build), gzip level 9",
    "build: local vite/vitest timings; CI job duration from gh api (run 44024925977, card/C2)",
    "loc: bench/scripts/loc.py, frontend and server counted separately",
    "cost: opencode session ledger + kanban/lead-log.md",
  ],
  headline:
    "The only track with a real cold-start number (174 ms to list visible, real Chrome) and the smallest artifact (89 kB gzipped) — " +
    "but image embedding costs 6.4–11.9 s per frame on the fp32 CPU path, ~4 orders of magnitude off the interactive 400 ms scan cadence.",
  measurements: {
    "coldStart.listVisible": from(cold, (d) => d.measurements?.["coldStart.listVisible"], "web cold start"),
    "coldStart.shellVisible": from(cold, (d) => d.measurements?.["coldStart.shellVisible"], "web shell visible"),
    "coldStart.navigation": from(cold, (d) => d.measurements?.navigation, "web navigation timing"),
    "coldStart.caveat":
      "localhost, no network latency, headless Chrome on this laptop, fresh profile per run. A real phone over 4G is slower " +
      "(download of ~89 kB gzipped + TLS). It is still the only track where the number exists at all.",
    embed: {
      status: "recorded",
      source: PERF,
      note: "host, in-process, model warm; the container caps at 4 threads and is slower. Re-run recipe is in PERF.md.",
      text: {
        "1 text, cache miss": { p50Ms: 295, rangeMs: [88, 573], n: 30 },
        "1 text, cache hit": { p50Ms: 0.04, n: 1 },
        "43 texts (batched)": { perTextMs: [44, 83], requestMs: [1900, 3600], n: 43 },
        "model load": { ms: 2300, rangeMs: [2100, 2800] },
        "load + first embed (cold process)": { ms: 4400, rangeMs: [4100, 4700] },
      },
      image: {
        "1 product JPEG, cache miss": { p50Ms: 7200, samplesMs: [6400, 6700, 7700, 7900], secondRunMs: [8300, 11900], n: 4 },
        "HTTP /embed/image, cold": { rangeMs: [6800, 8000], n: 2 },
        "HTTP /embed/image in container": { ms: 10700, n: 1 },
      },
      live: na(
        "not re-run by X1: the embedding server needs torch + sentence-transformers (~2 GB) in a venv and the laptop's disk " +
        "quota was already purged once for space (lead log, C2 closeout). PERF.md is the recorded measurement with its own " +
        "reproduce section; re-running it is one command on a machine with the venv.",
      ),
    },
    rank200: from(tsCoreRank, (d) => d.measurements?.rank200, "ts-core rank200"),
    "rank200.coldFirstTick": from(tsCoreRank, (d) => d.measurements?.["rank200.coldFirstTick"], "ts-core cold first tick"),
    "rank200.label":
      "ts-core numbers measured in node; the browser runs the same module in V8, which is a fairer match than Hermes. " +
      "No embedder call is included — this is the pure ranker, which is what the card asks for.",
    bundle: from(sizes, (d) => d.tracks?.web?.dist, "web dist sizes"),
    loc: { frontend: locOf("web.frontend"), server: locOf("web.server") },
    buildTime: buildOf("web"),
    agentCost: costOf("web"),
    sanity: from(tsCoreRank, (d) => d.sanity, "ts-core sanity"),
  },
};

/* ------------------------------------------------------------------ oracle */
const oracle = {
  generatedAt: new Date().toISOString(),
  track: "oracle",
  implementation: "shared/ref/scanlist_ref.py — the normative Python reference (numpy), ships in no app",
  provenance: [
    "rank: bench/scripts/rank-oracle.py over the same 200-item fixture as the ts-core and Kotlin runs",
    "loc: bench/scripts/loc.py over shared/ (ts-core + oracle + android-embed + spec/fixtures)",
    "cost: shared/S-cards are foundation work, reported but not a track",
  ],
  headline:
    "The reference every track is graded against: 1.59 ms p50 for 200 items with numpy matmul — slower than the Kotlin port, " +
    "faster than nothing, and the only implementation whose output is normative.",
  measurements: {
    rank200: from(oracleRank, (d) => d.measurements?.rank200, "oracle rank200"),
    "rank200.coldFirstTick": from(oracleRank, (d) => d.measurements?.["rank200.coldFirstTick"], "oracle cold first tick"),
    decideTop200: from(oracleRank, (d) => d.measurements?.decideTop200, "oracle decideTop200"),
    "rank200.label": "oracle datum, not a track: nothing ships this. It exists so the two real rankers can be read against the reference.",
    loc: locOf("shared"),
    agentCost: costOf("shared"),
    sanity: from(oracleRank, (d) => d.sanity, "oracle sanity"),
  },
};

mkdirSync(OUT, { recursive: true });
for (const [name, payload] of Object.entries({ kotlin, rn, web, oracle })) {
  writeFileSync(resolve(OUT, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
}

const fmt = (v) =>
  v === undefined
    ? "—"
    : v?.status === "n/a" || v?.status === "recorded"
      ? v.status
      : v?.p50 !== undefined
        ? `${v.p50.toFixed(2)} ms p50`
        : v?.status === "measured"
          ? "measured"
          : "?";

const artifactBytes = (m) =>
  m.apk?.status === "measured"
    ? m.apk.bytes
    : (m.apk?.apkCi?.bytes ?? m.apk?.apkLocal?.bytes ?? m.bundle?.shipped?.bytes ?? null);

console.log(`track   rank200           coldStart.list      artifact                 loc(code)`);
for (const [name, payload] of Object.entries({ kotlin, rn, web, oracle })) {
  const m = payload.measurements;
  const bytes = artifactBytes(m);
  const artifactText = bytes ? `${(bytes / 1048576).toFixed(2)} MB` : "n/a";
  const locCode = m.loc?.code ?? ((m.loc?.frontend?.code ?? 0) + (m.loc?.server?.code ?? 0) || "n/a");
  console.log(
    `${name.padEnd(8)}${String(fmt(m.rank200)).padEnd(19)}${String(fmt(m["coldStart.listVisible"])).padEnd(20)}` +
      `${artifactText.padEnd(25)}${locCode}`,
  );
}
console.log("-> bench/results/{kotlin,rn,web,oracle}.json");
