/**
 * Dev-only spike page controller (card C7).
 *
 * Open it with `npm run dev` and go to `/src/embed-spike/index.html` — it is a standalone HTML
 * entry INSIDE src/, so `vite build` (which only has the root `index.html` as input) never touches
 * it and the production bundle is byte-for-byte what it was before this card.
 *
 * The page can be driven by hand (buttons) or headlessly through `window.__c7`, which is what the
 * measurement harness in `EMBED_SPIKE.md` used (`cdp.mjs`-style CDP eval):
 *
 *   await window.__c7.probe()                     // adapter facts only, no download
 *   await window.__c7.run()                       // full measurement, returns the report
 *   await window.__c7.run({ device: "wasm" })     // q4-on-WASM trap check (expected to fail)
 *   window.__c7.report                            // last report (JSON)
 */

import { buildScenario, loadGolden, photoUrl } from "./fixtures";
import { runMeasurement } from "./harness";
import type { EmbedSession, SpikeReport } from "./session";
import { createGemmaSession, probeAdapter } from "./model";
import type { LoadMetrics } from "./session";

interface RunOptions {
  device?: "webgpu" | "wasm";
  dtype?: string;
  textOnly?: boolean;
  maxImages?: number;
  textRepeats?: number;
  imageRepeats?: number;
  /** Per-model-call watchdog in seconds (0 = off); headless runs set it to fail fast. */
  callTimeoutSec?: number;
}

interface C7Api {
  run(options?: RunOptions): Promise<SpikeReport>;
  probe(): Promise<unknown>;
  /** Load the model without running the suite; the session is kept on `session` for ad-hoc probes. */
  loadModel(options?: RunOptions): Promise<LoadMetrics>;
  report: SpikeReport | null;
  load: LoadMetrics | null;
  session: EmbedSession | null;
  /** Dev URL for a `shared/fixtures/photos/*` file (ad-hoc probes). */
  photo(file: string): string;
  /** The parsed golden fixture (ad-hoc parity checks without the full suite). */
  golden(): ReturnType<typeof loadGolden>;
  errors: string[];
}

const logEl = document.getElementById("log");
const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");

function log(line: string): void {
  const text = `[${new Date().toISOString().slice(11, 23)}] ${line}`;
  if (logEl) logEl.textContent = `${logEl.textContent ?? ""}${text}\n`;
  // eslint-disable-next-line no-console -- the CDP driver reads console lines as a live log
  console.log(text);
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function fmt(value: number | null | undefined, unit = "ms"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 10 ? 2 : 0)} ${unit}`;
}

function renderReport(report: SpikeReport): void {
  const load = report.load;
  const rows: [string, string][] = [
    ["Generated", report.generatedAt],
    ["UA", report.environment.userAgent],
    [
      "Adapter",
      report.environment.adapter
        ? `${report.environment.adapter.vendor}/${report.environment.adapter.architecture}`
        : "none (no WebGPU)",
    ],
    ["device / dtype", `${report.environment.device} / ${report.environment.dtype}`],
    ["lib import", fmt(load?.libImportMs)],
    ["model load (incl. download)", fmt(load?.modelLoadMs)],
    ["weights (reported)", load ? `${(load.weightsBytes / 1e6).toFixed(1)} MB` : "—"],
    ["total to ready", fmt(load?.totalMs)],
    ["cold first text embed", fmt(report.text.coldFirstMs)],
    ["docs total (n=" + report.text.docCount + ")", fmt(report.text.docTotalMs)],
    [
      "batches",
      report.text.batches
        .map((batch) => `${batch.size} docs/${batch.tokens} tok = ${fmt(batch.ms)}`)
        .join(" · ") || "—",
    ],
    ["warm single query median", fmt(report.text.singleQuery?.median)],
    ["warm single query p90", fmt(report.text.singleQuery?.p90)],
    ["single image median", fmt(report.image.single?.median)],
    [
      "image batch",
      report.image.batch
        ? `${report.image.batch.size} imgs/${report.image.batch.tokens} tok = ${fmt(report.image.batch.ms)} (${fmt(report.image.batch.perItemMs)}/img)`
        : "—",
    ],
    ["256-slice norm before re-normalise", fmt(report.image.sliceNormMean, "")],
    [
      "doc parity (min/median cos)",
      `${report.parity.docs.minCosine.toFixed(6)} / ${report.parity.docs.medianCosine.toFixed(6)} (n=${report.parity.docs.n})`,
    ],
    [
      "query parity (min/median cos)",
      `${report.parity.queries.minCosine.toFixed(6)} / ${report.parity.queries.medianCosine.toFixed(6)} (n=${report.parity.queries.n})`,
    ],
    [
      "image parity (min/median cos)",
      `${report.parity.images.minCosine.toFixed(6)} / ${report.parity.images.medianCosine.toFixed(6)} (n=${report.parity.images.n})`,
    ],
    ["rank() top-1 vs golden", `${report.parity.top1.hits}/${report.parity.top1.total}`],
    [
      "flat vs nested image",
      report.traps.flatVsNested
        ? report.traps.flatVsNested.flatCosineVsNested.map((value) => value.toFixed(4)).join(" / ")
        : "—",
    ],
  ];
  const table = `<table>${rows
    .map(([key, value]) => `<tr><th>${key}</th><td>${value}</td></tr>`)
    .join("")}</table>`;
  if (resultEl) {
    resultEl.innerHTML = `${table}<details><summary>raw report JSON</summary><pre>${JSON.stringify(
      report,
      null,
      2,
    )}</pre></details>`;
  }
}

const api: C7Api = {
  report: null,
  load: null,
  session: null,
  photo: photoUrl,
  golden: loadGolden,
  errors: [],
  async probe() {
    const adapter = await probeAdapter();
    log(adapter ? `adapter: ${JSON.stringify(adapter)}` : "adapter: none");
    return adapter;
  },
  async loadModel(options: RunOptions = {}) {
    const { session, load } = await createGemmaSession({
      device: options.device ?? "webgpu",
      dtype: options.dtype ?? "q4",
      textOnly: options.textOnly ?? false,
      onProgress: log,
    });
    api.session = session;
    api.load = load;
    api.session = session;
    return load;
  },
  async run(options: RunOptions = {}) {
    const scenario = buildScenario({
      maxImages: options.maxImages ?? 3,
    });
    setStatus("running");
    log(
      `scenario: list=${scenario.listId} items=${scenario.items.length} textQueries=${scenario.textQueries.length} images=${scenario.images.length}`,
    );
    log(`prefixes: active=${scenario.prompts.active} doc=${JSON.stringify(scenario.prompts.doc)} image=${JSON.stringify(scenario.prompts.image)}`);

    const { session, load } = await createGemmaSession({
      device: options.device ?? "webgpu",
      dtype: options.dtype ?? "q4",
      textOnly: options.textOnly ?? false,
      onProgress: log,
    });
    api.load = load;
    api.session = session;

    const started = performance.now();
    const images = [];
    for (const spec of scenario.images) {
      const decodeStarted = performance.now();
      const handle = session.loadImage ? await session.loadImage(spec.url) : spec.url;
      log(`image ${spec.id}: decoded in ${(performance.now() - decodeStarted).toFixed(0)} ms`);
      images.push({ id: spec.id, handle, vector: spec.vector, expectedTop3: spec.expectedTop3 });
    }

    const report = await runMeasurement(
      {
        session,
        prompts: scenario.prompts,
        items: scenario.items,
        itemVectors: scenario.itemVectors,
        textQueries: scenario.textQueries,
        images,
      },
      {
        textRepeats: options.textRepeats ?? 5,
        imageRepeats: options.imageRepeats ?? 3,
        onStage: log,
        callTimeoutMs: (options.callTimeoutSec ?? 0) * 1000,
        environment: {
          userAgent: navigator.userAgent,
          device: session.device,
          dtype: session.dtype,
          adapter: load.adapter,
          webgpu: load.adapter !== null,
          load,
        },
      },
    );
    log(`measurement finished in ${(performance.now() - started).toFixed(0)} ms`);
    api.report = report;
    renderReport(report);
    setStatus("done");
    return report;
  },
};

const w = window as unknown as { __c7?: C7Api };
w.__c7 = api;

const runButton = document.getElementById("run");
runButton?.addEventListener("click", () => {
  const device = (document.getElementById("device") as HTMLSelectElement | null)?.value ?? "webgpu";
  const dtype = (document.getElementById("dtype") as HTMLSelectElement | null)?.value ?? "q4";
  const textOnly = (document.getElementById("textOnly") as HTMLInputElement | null)?.checked ?? false;
  api.run({ device: device === "wasm" ? "wasm" : "webgpu", dtype, textOnly }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    api.errors.push(message);
    log(`FAILED: ${message}`);
    setStatus("failed");
  });
});

// ?autorun=1&device=webgpu&dtype=q4&textOnly=0 — the headless path (see EMBED_SPIKE.md).
const params = new URLSearchParams(location.search);
if (params.get("autorun") === "1") {
  const device = params.get("device") === "wasm" ? "wasm" : "webgpu";
  api
    .run({
      device,
      dtype: params.get("dtype") ?? "q4",
      textOnly: params.get("textOnly") === "1",
      maxImages: Number(params.get("maxImages") ?? "3"),
      textRepeats: Number(params.get("textRepeats") ?? "5"),
      imageRepeats: Number(params.get("imageRepeats") ?? "3"),
      callTimeoutSec: Number(params.get("callTimeoutSec") ?? "0"),
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      api.errors.push(message);
      log(`AUTORUN FAILED: ${message}`);
      setStatus("failed");
    });
}

log(`ready — webgpu=${String((navigator as unknown as { gpu?: unknown }).gpu !== undefined)}`);
