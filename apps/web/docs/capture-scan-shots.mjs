/**
 * Captures the C5 screenshots in `screenshots/` from the BUILT app (real Chrome, headless, fake
 * camera). The embedding HTTP endpoints are stubbed in-browser so the ranked rows are the real UI
 * instead of a server-404 state; OCR is the real Tesseract pipeline.
 *
 * Usage (from apps/web/frontend):
 *   npm run build
 *   npx vite preview --port 8412 --strictPort &
 *   npm i --no-save puppeteer-core
 *   BANANAS_Y4M=/path/to/bananas.y4m node ../docs/capture-scan-shots.mjs
 *
 * Env: SMOKE_BASE_URL (default http://127.0.0.1:8412), SHOT_OUT (default /tmp/opencode/c5-shots),
 * CHROME_PATH (default /usr/bin/google-chrome), BANANAS_Y4M (required).
 *
 * The fake-camera fixture is NOT committed: it is ~4.4 MB of raw YUV video, which the no-large-
 * binaries rule keeps out of git. See README.md ("Re-capturing the screenshots") for its exact
 * format and how to regenerate it.
 */

import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8412";
const OUT = process.env.SHOT_OUT ?? "/tmp/opencode/c5-shots";
const VIDEO = process.env.BANANAS_Y4M ?? "";

if (VIDEO === "" || !existsSync(VIDEO)) {
  console.error(
    "BANANAS_Y4M must point at the fake-camera fixture (640x480, C420jpeg y4m of the word " +
      "BANANAS). It is not committed; see apps/web/docs/README.md for the recipe.",
  );
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-video-capture=${VIDEO}`,
  ],
  defaultViewport: { width: 420, height: 900, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));

const docAxes = new Map();
function vectorFor(text, kind) {
  if (kind === "doc") {
    if (!docAxes.has(text)) docAxes.set(text, docAxes.size);
    const axis = docAxes.get(text);
    const vector = new Array(256).fill(0);
    vector[axis] = 1;
    return vector;
  }
  // Every query lands on the first item with a realistic similarity; the rest score ~0.
  const vector = new Array(256).fill(0);
  if (docAxes.size === 0) docAxes.set("first", 0);
  vector[0] = 0.86;
  vector[255] = Math.sqrt(1 - 0.86 * 0.86);
  return vector;
}

await page.setRequestInterception(true);
page.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/embed/text" && request.method() === "POST") {
    const body = JSON.parse(request.postData() ?? "{}");
    const texts = Array.isArray(body.texts) ? body.texts : [];
    const embeddings = texts.map((text) => vectorFor(text, body.kind ?? "query"));
    await request.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ embeddings, dims: 256, backend: "stub", model: "stub" }),
    });
    return;
  }
  if (url.pathname === "/embed/image" && request.method() === "POST") {
    // Orthogonal to every item doc: image evidence is visible in the chips but never outranks the
    // (text-driven) label match — an image-only hero would need barcode accept-list confirmation.
    const vector = new Array(256).fill(0);
    vector[200] = 1;
    await request.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ embeddings: [vector], dims: 256, backend: "stub", model: "stub" }),
    });
    return;
  }
  await request.continue();
});

const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
const waitForText = (needle, timeout = 10000) =>
  page.waitForFunction((value) => document.body.innerText.includes(value), { timeout }, needle);
const clickText = async (selector, needle) => {
  const clicked = await page.evaluate(
    (sel, value) => {
      const node = Array.from(document.querySelectorAll(sel)).find((element) =>
        (element.textContent ?? "").includes(value),
      );
      if (!node) return false;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    },
    selector,
    needle,
  );
  if (!clicked) throw new Error(`no ${selector} containing ${JSON.stringify(needle)}`);
};

// 1. no list yet: the Scan nav is enabled and the screen is honest instead of dead.
await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
await waitForText("IMPORT A LIST");
await clickText("button.nav-item", "Scan");
await waitForText("NO LIST OPEN");
await page.screenshot({ path: `${OUT}/01-scan-no-list.png`, fullPage: true });

// 2. import the demo list, then open Scan from the lists screen.
await clickText("md-filled-button", "Back to lists");
await waitForText("IMPORT A LIST");
await clickText("md-text-button", "Load the demo list");
await waitForText("Van weekly shop");
await clickText("button", "Lists");
await waitForText("SAVED LISTS");
await clickText("button.nav-item", "Scan");
await waitForText("MAGIC SCAN");
// Docs embed on the first tick; the image query needs one captured frame, so wait for a real rank
// table (hero is honestly null: an image-only match needs barcode accept-list confirmation).
await waitForText("NO CONFIDENT MATCH", 12000);
// Drop the import toast so it does not sit on top of the hero in the docs screenshot.
await page.evaluate(() => document.querySelector(".toast-close")?.click());
await new Promise((resolve) => setTimeout(resolve, 600));
await page.screenshot({ path: `${OUT}/02-scan-camera-live.png` });

// 3. the fake camera streams a large "BANANAS" label; real Tesseract reads it, so the hero is a
// text-driven match (no barcode accept-list needed) — the actual "magic scan" moment.
await waitForText("BEST MATCH", 120000);
await new Promise((resolve) => setTimeout(resolve, 500));
await page.screenshot({ path: `${OUT}/03-scan-hero.png` });

// 4. scrolled: the same ranked table the hero came from.
await page.evaluate(() => document.getElementById("scan-rank-heading")?.scrollIntoView());
await new Promise((resolve) => setTimeout(resolve, 400));
await page.screenshot({ path: `${OUT}/04-scan-ranked-list.png` });

const summary = await text();
console.log("CAMERA:", /CAMERA (LIVE|UNAVAILABLE|OFF)/.exec(summary)?.[0] ?? "unknown");
console.log("HERO:", /BEST MATCH|NO CONFIDENT MATCH|READING YOUR LIST/.exec(summary)?.[0] ?? "none");
console.log("CHIPS:", /QUERIES \d+\/16/.exec(summary)?.[0] ?? "missing");
console.log(pageErrors.length === 0 ? "no page errors" : pageErrors.join("\n"));

await browser.close();
