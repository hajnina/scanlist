#!/usr/bin/env node
/**
 * X1 — web cold start to **list visible**, in a real Chrome, against the built `dist/`.
 *
 * The native tracks cannot be measured (no phone on adb — card B0 is blocked), so this is the only
 * track with a real cold-start number. It follows the pattern of the existing, read-only
 * `apps/web/frontend/scripts/smoke-e2e.mjs` (headless Chrome + puppeteer-core, same `.library-button`
 * / `.item` selectors) but measures instead of asserting, and it never writes into apps/web.
 *
 * Definition used here (documented in the README):
 *   shell  = navigation start -> the "Lists" screen is on screen (`.library-button` present)
 *   list   = navigation start -> the FIRST list row is on screen after opening a saved list
 * The browser is launched fresh for every run (new user-data-dir, cold HTTP cache), and the app is
 * served by a static server in this process, so nothing is warm from a previous visit. The seeded
 * list is `shared/spec/samples/van-weekly.json` (10 items) written into the app's own localStorage
 * keys, i.e. exactly what the app writes after an import — the app then parses it with ts-core on
 * boot, which is the JS equivalent of "app starts with a stored list".
 *
 *   node bench/scripts/coldstart-web.mjs            # needs apps/web/frontend/dist (npm run build)
 *
 * Writes bench/results/fragments/coldstart-web.json.
 */
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, "..");
const REPO = resolve(BENCH, "..");
const DIST = resolve(REPO, "apps/web/frontend/dist");
const require = createRequire(resolve(BENCH, "package.json"));

const RUNS = Number(process.env.X1_COLD_RUNS ?? "7");
const PORT = Number(process.env.X1_COLD_PORT ?? "8413");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1], mean, unit: "ms" };
}

/** Tiny static server for dist/ — same-origin so localStorage/service worker behave like production. */
function serveDist() {
  return createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = join(DIST, urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file)) file = join(DIST, "index.html"); // SPA fallback
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

const SAMPLE = resolve(REPO, "shared/spec/samples/van-weekly.json");

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error(`missing ${DIST}/index.html — run: (cd apps/web/frontend && npm install && npm run build)`);
  }
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME} — set CHROME_PATH`);
  const puppeteer = (await import(require.resolve("puppeteer-core"))).default;
  const sample = JSON.parse(await readFile(SAMPLE, "utf8"));
  const listId = "x1-coldstart";
  const doc = { version: 1, ...sample };
  const countItems = (sections) =>
    sections.reduce(
      (n, s) => n + (s.items?.length ?? 0) + (s.sections ? countItems(s.sections) : 0),
      0,
    );
  const now = new Date().toISOString();
  const index = {
    version: 1,
    lists: [
      {
        id: listId,
        title: doc.title,
        itemCount: countItems(doc.sections),
        doneCount: 0,
        importedAt: now,
        updatedAt: now,
      },
    ],
  };

  const server = serveDist();
  await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${PORT}`;

  const shell = [];
  const list = [];
  const nav = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      const profile = await mkdtemp(join(tmpdir(), "x1-chrome-"));
      const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: "new",
        userDataDir: profile, // fresh profile every run => cold cache, cold service worker
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        defaultViewport: { width: 420, height: 900, deviceScaleFactor: 2 },
      });
      try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(
          (idx, key, value) => {
            localStorage.setItem("scanlist.v1.lists", idx);
            localStorage.setItem(key, value);
          },
          JSON.stringify(index),
          `scanlist.v1.list.${listId}`,
          JSON.stringify(doc),
        );

        const t0 = process.hrtime.bigint();
        await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".library-button", { timeout: 15000 });
        const shellMs = Number(process.hrtime.bigint() - t0) / 1e6;

        await page.click(".library-button");
        await page.waitForFunction(
          () => {
            const item = document.querySelector(".item");
            return item !== null && item.getBoundingClientRect().height > 0;
          },
          { timeout: 15000 },
        );
        const listMs = Number(process.hrtime.bigint() - t0) / 1e6;

        const timing = await page.evaluate(() => {
          const n = performance.getEntriesByType("navigation")[0];
          return n ? { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd, ttfb: n.responseStart } : null;
        });
        shell.push(shellMs);
        list.push(listMs);
        if (timing) nav.push(timing);
      } finally {
        await browser.close();
        await rm(profile, { recursive: true, force: true });
      }
    }
  } finally {
    server.close();
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    implementation: "apps/web/frontend dist/ (Preact + @material/web + ts-core), served same-origin",
    provenance: {
      pattern: "reuses the headless-Chrome approach of apps/web/frontend/scripts/smoke-e2e.mjs (read-only; not edited)",
      browser: `${CHROME} (headless new), puppeteer-core`,
      build: "apps/web/frontend/dist from `npm run build` (tsc --noEmit && vite build)",
      list: "shared/spec/samples/van-weekly.json seeded into the app's own localStorage keys",
      definition: "t0 = page.goto start; shell = .library-button on screen; list = first .item with height > 0 after opening the saved list",
    },
    environment: { runs: RUNS, port: PORT, chrome: CHROME, node: process.version },
    measurements: {
      "coldStart.shellVisible": stats(shell),
      "coldStart.listVisible": stats(list),
      "navigation": nav.length
        ? {
            status: "measured",
            p50: {
              ttfb: percentile(nav.map((n) => n.ttfb).sort((a, b) => a - b), 50),
              domContentLoaded: percentile(nav.map((n) => n.domContentLoaded).sort((a, b) => a - b), 50),
              load: percentile(nav.map((n) => n.load).sort((a, b) => a - b), 50),
            },
            unit: "ms",
          }
        : { status: "n/a", reason: "navigation timing unavailable" },
    },
  };
  const out = resolve(BENCH, "results/fragments/coldstart-web.json");
  await (await import("node:fs/promises")).mkdir(dirname(out), { recursive: true });
  await (await import("node:fs/promises")).writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);

  const l = stats(list);
  const s = stats(shell);
  console.log(
    `web cold start (real Chrome, ${RUNS} fresh profiles): shell visible p50 ${s.p50.toFixed(0)} ms / p95 ${s.p95.toFixed(0)} ms; ` +
      `list visible p50 ${l.p50.toFixed(0)} ms / p95 ${l.p95.toFixed(0)} ms (min ${l.min.toFixed(0)}, max ${l.max.toFixed(0)})`,
  );
  console.log("-> bench/results/fragments/coldstart-web.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
