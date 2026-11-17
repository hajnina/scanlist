#!/usr/bin/env node
/**
 * X1 — artifact sizes: APKs, the RN JS bundle, and the web build, with per-ABI and per-component
 * breakdowns. Sizes are the second axis (after latency) where the three tracks genuinely differ.
 *
 * Nothing here builds anything. It measures whatever exists on disk and reports `n/a` with the exact
 * command that would produce the missing file, so the script is honest on a partial checkout:
 *
 *   Kotlin APK   apps/kotlin/app/build/outputs/apk/debug/scanlistKotlin-debug.apk
 *                (source scripts/android-env.sh && ./gradlew :scanlistKotlin:assembleDebug)
 *   Kotlin CI APK  env X1_KOTLIN_CI_APK   (gh run download <run> -n scanlist-kotlin-apk -D dir)
 *   RN APK       env X1_RN_APK            (gh run download <run> -n scanlist-rn-apk -D dir)
 *   RN bundle    env X1_RN_BUNDLE         (npx react-native bundle --platform android --dev false …)
 *   web dist     apps/web/frontend/dist   (cd apps/web/frontend && npm run build)
 *
 *   node bench/scripts/sizes.mjs           # -> bench/results/fragments/sizes.json
 *
 * APK internals are read with `unzip -l` (stored lengths), so a "lib" number is the uncompressed
 * native-code size — the part that dominates both APKs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, "..");
const REPO = resolve(BENCH, "..");

const na = (reason) => ({ status: "n/a", reason });

function fileEntry(path, source) {
  if (!path || !existsSync(path)) {
    return na(`missing ${path ?? "(no path given)"} — ${source}`);
  }
  return { status: "measured", bytes: statSync(path).size, path, source };
}

/** `unzip -l` -> { total, byGroup, byAbi } using stored (uncompressed) lengths. */
function apkBreakdown(path) {
  const out = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
  const byGroup = {};
  const byAbi = {};
  let entries = 0;
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    const bytes = Number(m[1]);
    const name = m[2].trim();
    if (name.endsWith("files") || name === "") continue;
    entries += 1;
    let group = "other";
    if (name.startsWith("lib/")) group = "lib";
    else if (name.startsWith("assets/")) group = "assets";
    else if (name.startsWith("res/")) group = "res";
    else if (name.startsWith("classes") && name.endsWith(".dex")) group = "dex";
    else if (name.startsWith("META-INF/")) group = "meta";
    byGroup[group] = (byGroup[group] ?? 0) + bytes;
    if (group === "lib") {
      const abi = name.split("/")[1];
      byAbi[abi] = (byAbi[abi] ?? 0) + bytes;
    }
  }
  return { entries, byGroup, byAbi };
}

function apk(path, source) {
  const entry = fileEntry(path, source);
  if (entry.status === "n/a") return entry;
  return { ...entry, ...apkBreakdown(path) };
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) files.push(...walk(path));
    else files.push({ path, bytes: st.size });
  }
  return files;
}

function webDist() {
  const dist = resolve(REPO, "apps/web/frontend/dist");
  if (!existsSync(join(dist, "index.html"))) {
    return na("missing apps/web/frontend/dist — (cd apps/web/frontend && npm install && npm run build)");
  }
  const files = walk(dist).sort((a, b) => b.bytes - a.bytes);
  const textExt = new Set([".js", ".css", ".html", ".webmanifest", ".svg"]);
  let raw = 0;
  let gzip = 0;
  let assetsRaw = 0;
  let assetsGzip = 0;
  let mapBytes = 0;
  const perAsset = [];
  for (const f of files) {
    raw += f.bytes;
    const ext = extname(f.path);
    const isAsset = f.path.includes(`${"/"}assets${"/"}`);
    const isMap = ext === ".map";
    if (isAsset) assetsRaw += f.bytes;
    if (isMap) {
      mapBytes += f.bytes;
      perAsset.push({ file: f.path.replace(`${dist}/`, ""), bytes: f.bytes, kind: "source-map" });
      continue;
    }
    if (textExt.has(ext)) {
      const gz = gzipSync(readFileSync(f.path), { level: 9 }).length;
      gzip += gz;
      if (isAsset) assetsGzip += gz;
      perAsset.push({ file: f.path.replace(`${dist}/`, ""), bytes: f.bytes, gzip: gz, kind: "text" });
    } else {
      gzip += f.bytes;
      if (isAsset) assetsGzip += f.bytes;
      perAsset.push({ file: f.path.replace(`${dist}/`, ""), bytes: f.bytes, kind: "binary" });
    }
  }
  return {
    status: "measured",
    path: "apps/web/frontend/dist",
    source: "npm run build (tsc --noEmit && vite build)",
    files: files.length,
    bytes: raw,
    gzipBytes: gzip,
    // Source maps are a debug artefact: the browser never downloads them unless devtools ask.
    sourceMapBytes: mapBytes,
    shipped: { bytes: raw - mapBytes, gzipBytes: gzip },
    assets: { bytes: assetsRaw - mapBytes, gzipBytes: assetsGzip },
    perAsset,
  };
}

function main() {
  const kotlinLocal = resolve(REPO, "apps/kotlin/app/build/outputs/apk/debug/scanlistKotlin-debug.apk");
  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      "bench/scripts/sizes.mjs — file sizes on disk; APK internals via `unzip -l` stored lengths; web dist gzip via zlib level 9 (one asset at a time, not the whole tarball)",
    note:
      "Both APKs are fat (all four ABIs, x86/x86_64 included for emulators). A per-ABI split would be roughly the `lib.<abi>` number plus dex; the per-ABI table is included so the split is a visible decision, not a hidden one.",
    tracks: {
      kotlin: {
        apkLocal: apk(kotlinLocal, "source scripts/android-env.sh && ./gradlew :scanlistKotlin:assembleDebug"),
        apkCi: apk(
          process.env.X1_KOTLIN_CI_APK,
          "gh run download <run-id> -n scanlist-kotlin-apk -D dir && export X1_KOTLIN_CI_APK=dir/ScanList-kotlin-debug.apk",
        ),
      },
      rn: {
        apkCi: apk(
          process.env.X1_RN_APK,
          "gh run download <run-id> -n scanlist-rn-apk -D dir && export X1_RN_APK=dir/ScanList-rn-debug.apk",
        ),
        jsBundle: fileEntry(
          process.env.X1_RN_BUNDLE,
          "cd apps/rn && npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/…/index.android.bundle",
        ),
      },
      web: {
        dist: webDist(),
      },
    },
  };
  const frag = resolve(BENCH, "results/fragments");
  mkdirSync(frag, { recursive: true });
  writeFileSync(resolve(frag, "sizes.json"), `${JSON.stringify(payload, null, 2)}\n`);

  const fmt = (e) => (e.status === "n/a" ? "n/a" : `${(e.bytes / 1048576).toFixed(1)} MB`);
  const t = payload.tracks;
  console.log(`kotlin APK (local)      ${fmt(t.kotlin.apkLocal)}`);
  console.log(`kotlin APK (CI)         ${fmt(t.kotlin.apkCi)}`);
  console.log(`rn APK (CI)             ${fmt(t.rn.apkCi)}`);
  console.log(`rn JS bundle            ${fmt(t.rn.jsBundle)}`);
  console.log(
    `web dist                ${fmt(t.web.dist)}` +
      (t.web.dist.status === "measured"
        ? ` (shipped ${(t.web.dist.shipped.bytes / 1024).toFixed(1)} kB raw / ` +
          `${(t.web.dist.shipped.gzipBytes / 1024).toFixed(1)} kB gzip; ` +
          `js+css ${(t.web.dist.assets.bytes / 1024).toFixed(1)} kB / ${(t.web.dist.assets.gzipBytes / 1024).toFixed(1)} kB gzip; ` +
          `source map ${(t.web.dist.sourceMapBytes / 1024).toFixed(0)} kB excluded)`
        : ""),
  );
  console.log("-> bench/results/fragments/sizes.json");
}

main();
