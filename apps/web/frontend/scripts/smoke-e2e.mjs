#!/usr/bin/env node
/**
 * Optional real-browser smoke test of the *built* app. Not part of `npm test` and not run by CI:
 * it needs a Chrome binary and puppeteer-core, which are deliberately not project dependencies.
 *
 * Usage (from apps/web/frontend):
 *   npm run build
 *   npx vite preview --port 8412 --strictPort &      # or any static server for dist/
 *   npm i --no-save puppeteer-core
 *   node scripts/smoke-e2e.mjs
 *
 * What it proves that unit tests cannot: the real @material/web custom elements render, the download
 * actually lands on disk, a *reload* re-imports from localStorage, corrupt data recovers to the
 * import screen, and the service worker + manifest make the app installable.
 *
 * Exit code is 1 if any check fails or the page logged an error, so it is safe to use as a gate.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8412";
const OUT = process.env.SMOKE_OUT_DIR ?? "/tmp/opencode/c2";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** The URL tab needs a document served by the preview server: copy a real sample into dist/. */
function stageUrlSample() {
  const source = join(here, "..", "..", "..", "..", "shared", "spec", "samples", "deep-nesting.json");
  const already = join(here, "..", "dist", "samples", "deep-nesting.json");
  mkdirSync(dirname(already), { recursive: true });
  if (existsSync(source)) writeFileSync(already, readFileSync(source));
  return "/samples/deep-nesting.json";
}

const sampleUrl = stageUrlSample();
mkdirSync(OUT, { recursive: true });
const downloads = join(OUT, "downloads");
mkdirSync(downloads, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 420, height: 900, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));

const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
const waitForText = (needle, timeout = 8000) =>
  page.waitForFunction((value) => document.body.innerText.includes(value), { timeout }, needle);

try {
  // 1. shell renders (real Lit components included)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await waitForText("IMPORT A LIST");
  check((await text()).includes("SAVED LISTS"), "home screen renders with real @material/web elements");
  check(
    (await page.$$eval("md-text-button", (nodes) => nodes.length)) > 0,
    "md-* components are defined and upgraded",
  );
  await page.screenshot({ path: join(OUT, "01-home.png"), fullPage: true });

  // 2. file import
  const uploadPath = join(OUT, "upload.json");
  writeFileSync(
    uploadPath,
    JSON.stringify({
      title: "Uploaded list",
      sections: [
        { name: "Pantry", items: [{ name: "Pasta", amount: 2, unit: "kg" }, { name: "Rice", amount: "3 bags" }] },
        { name: "Fridge", sections: [{ name: "Dairy", items: [{ name: "Oat milk", note: "barista" }] }] },
      ],
    }),
  );
  const fileInput = await page.$('input[type="file"]');
  await fileInput.uploadFile(uploadPath);
  await waitForText("PROGRESS");
  const listText = await text();
  check(listText.includes("Uploaded list"), "file import opens the list");
  check(listText.includes("Dairy") && listText.includes("barista"), "nested section + note render");
  // The spring-in animation is 480 ms + up to 240 ms stagger: let it land before the screenshot.
  await new Promise((resolve) => setTimeout(resolve, 800));
  await page.screenshot({ path: join(OUT, "02-list.png"), fullPage: true });

  // 3. tick persists in the stored export document
  const docKey = await page.evaluate(() =>
    Object.keys(localStorage).find((key) => key.startsWith("scanlist.v1.list.")) ?? null,
  );
  const before = await page.evaluate((key) => localStorage.getItem(key), docKey);
  await page.click("md-checkbox");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await page.evaluate((key) => localStorage.getItem(key), docKey);
  check(!before.includes('"done": true') && after.includes('"done": true'), "tick is written to localStorage");
  check((await text()).includes("1 of 3 done"), "progress card follows the tick");
  await page.screenshot({ path: join(OUT, "03-ticked.png"), fullPage: true });

  // 4. export downloads the same document
  const client = await page.target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await page.$$eval("md-filled-button", (nodes) => {
    nodes.find((node) => node.textContent.includes("Export JSON"))?.click();
  });
  await waitForText("Exported");
  let exported = [];
  for (let attempt = 0; attempt < 20 && exported.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    exported = readdirSync(downloads).filter((name) => name.endsWith(".json"));
  }
  check(exported.includes("uploaded-list.json"), "export downloads <title>.json", exported.join(","));
  const downloaded = exported.includes("uploaded-list.json")
    ? JSON.parse(readFileSync(join(downloads, "uploaded-list.json"), "utf8"))
    : { sections: [] };
  const pasta = downloaded.sections?.[0]?.items?.[0];
  check(pasta?.name === "Pasta" && pasta?.done === true, "downloaded document keeps the tick");

  // 5. URL import (same-origin sample, served from dist/)
  await page.click(".back-button");
  await waitForText("IMPORT A LIST");
  const chips = await page.$$("button.chip");
  await chips[2].click();
  const urlField = await page.$("md-outlined-text-field");
  await urlField.click();
  await page.keyboard.type(sampleUrl);
  await page.keyboard.press("Enter");
  await waitForText("PROGRESS");
  check((await text()).includes("Deep pantry audit"), "URL import opens the fetched list", sampleUrl);
  await page.click(".back-button");
  await waitForText("SAVED LISTS");
  check((await text()).includes("Uploaded list"), "library keeps both lists");

  // 6. invalid paste shows the ts-core pointer inline
  const chips2 = await page.$$("button.chip");
  await chips2[1].click();
  await page.type("textarea.paste-area", '{"title": "x", "sections": [{"name": "A", "items": [{"name": 3}]}]}');
  await page.$$eval("md-filled-button", (nodes) => {
    nodes.find((node) => node.textContent.includes("Import pasted JSON"))?.click();
  });
  await waitForText("Import failed");
  const inlineError = await page.evaluate(() => document.querySelector(".import-errors")?.innerText ?? "");
  check(inlineError.includes("/sections/0/items/0/name"), "invalid paste shows the RFC 6901 pointer", inlineError.split("\n")[1] ?? "");
  await page.screenshot({ path: join(OUT, "04-errors.png"), fullPage: true });

  // 7. reload re-imports from localStorage
  await page.reload({ waitUntil: "networkidle0" });
  await waitForText("SAVED LISTS");
  const reloaded = await text();
  check(reloaded.includes("Uploaded list") && reloaded.includes("Deep pantry audit"), "saved lists survive a reload");
  check(reloaded.includes("2 left") || reloaded.includes("1 left"), "tick counts survive a reload");

  // 8. corrupt document -> import screen + error toast (no white screen)
  await page.evaluate((key) => localStorage.setItem(key, '{"title": "broken", "sections": [}'), docKey);
  await page.reload({ waitUntil: "networkidle0" });
  await waitForText("Uploaded list");
  await page.$$eval("button.library-button", (nodes) => {
    nodes.find((node) => node.textContent.includes("Uploaded list"))?.click();
  });
  await waitForText("IMPORT A LIST");
  const recovered = await text();
  check(recovered.includes("corrupt"), "corrupt document falls back to the import screen with a toast");
  check((await page.$$(".toast-error")).length > 0, "the recovery is announced as an error toast");
  await page.screenshot({ path: join(OUT, "05-corrupt-recovery.png"), fullPage: true });

  // 9. corrupt index -> import screen + error toast
  await page.evaluate(() => localStorage.setItem("scanlist.v1.lists", "{broken"));
  await page.reload({ waitUntil: "networkidle0" });
  await waitForText("IMPORT A LIST");
  const afterIndexDamage = await text();
  check(afterIndexDamage.includes("not valid JSON"), "corrupt index recovers with an error toast");
  check((await page.$$(".toast-error")).length > 0, "index recovery is a toast, not a blank page");

  // 10. installable PWA: manifest + registered service worker
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    return { status: response.status, body: await response.json() };
  });
  check(manifest.status === 200 && manifest.body.icons.length >= 3, "manifest is served with icons");
  const activeWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return "none";
    return registration.active ? "active" : registration.installing ? "installing" : "waiting";
  });
  check(["active", "installing", "waiting"].includes(activeWorker), "service worker registers", activeWorker);

  // 11. dark scheme still renders (M3 tokens, no flash to white)
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.reload({ waitUntil: "networkidle0" });
  await waitForText("IMPORT A LIST");
  await page.screenshot({ path: join(OUT, "06-dark.png"), fullPage: true });
  check(true, "dark scheme renders");
} catch (error) {
  check(false, "unexpected failure", error instanceof Error ? error.message : String(error));
} finally {
  check(pageErrors.length === 0, "no console or page errors", pageErrors.join(" | "));
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} (screenshots: ${OUT})`);
process.exit(failures === 0 ? 0 : 1);
