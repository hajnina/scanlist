#!/usr/bin/env node
/**
 * X1 — build time per track: how long it takes to go from a clean module to a runnable artifact.
 *
 * Everything here is measured by this script, on this laptop, wall-clock around the real command
 * (`/usr/bin/time`-style, but the timer is node's hrtime around the child process, so it includes
 * JVM/daemon startup and npm/npx startup — the number a person actually waits).
 *
 *   node bench/scripts/buildtimes.mjs              # vite + jest + metro + gradle (warm + cold)
 *   node bench/scripts/buildtimes.mjs --skip-gradle
 *   node bench/scripts/buildtimes.mjs --ci         # also pull CI job durations from gh
 *
 * Prerequisites (documented in the README, all gitignored):
 *   apps/web/frontend/node_modules   (npm install)
 *   apps/rn/node_modules             (npm ci)
 *   android toolchain                (scripts/android-env.sh; Gradle home warm)
 *
 * Writes bench/results/fragments/buildtimes.json.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, "..");
const REPO = resolve(BENCH, "..");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

function timed(command, { cwd, shell = false, env } = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(shell ? "bash" : command, shell ? ["-lc", command] : [], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ");
  return {
    status: result.status === 0 ? "measured" : "failed",
    wallMs: Math.round(ms),
    exitCode: result.status,
    command,
    cwd: cwd?.replace(`${REPO}/`, "") ?? ".",
    tail,
  };
}

const na = (reason) => ({ status: "n/a", reason });

/** Per-job CI durations for the PR runs that produced the APKs/dist we measured. */
function ciJobs() {
  const runs = {
    kotlin: "44026921235", // PR build, card/B6 — kotlin job built scanlist-kotlin-apk
    rn: "44023804443", // PR build, card/A2 — rn job built scanlist-rn-apk
    web: "44024925977", // PR build, card/C2 — web job built scanlist-web-dist
  };
  const out = {};
  for (const [track, runId] of Object.entries(runs)) {
    try {
      const json = execFileSync(
        "gh",
        ["api", `/repos/hajnina/scanlist/actions/runs/${runId}/jobs`],
        { encoding: "utf8", timeout: 30000 },
      );
      const jobs = JSON.parse(json).jobs ?? [];
      const job = jobs.find((j) => j.name === track);
      out[track] = job
        ? {
            status: "measured",
            runId,
            job: job.name,
            conclusion: job.conclusion,
            seconds: Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000),
            source: `gh api .../actions/runs/${runId}/jobs`,
          }
        : { status: "n/a", reason: `no '${track}' job in run ${runId}` };
    } catch (err) {
      out[track] = { status: "n/a", reason: `gh unavailable or run not found: ${String(err).slice(0, 120)}` };
    }
  }
  return out;
}

function main() {
  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      "bench/scripts/buildtimes.mjs — wall clock around the real build command (includes JVM/daemon and npm/npx startup). " +
      "gradle 'warm' = incremental assembleDebug with the Gradle build cache; 'cold' = `clean … --no-build-cache` (all tasks executed). " +
      "Dependency download time is excluded: node_modules and the Gradle home were already populated.",
    note:
      "This laptop is aarch64 and uses the hand-built toolchain in scripts/android-env.sh (aapt2 override). CI is x86_64 and uses the Maven aapt2; CI numbers are per-job durations from the PR runs that produced the artifacts measured in sizes.json.",
    tracks: {
      kotlin: {
        gradleWarm: has("--skip-gradle")
          ? na("skipped (--skip-gradle)")
          : timed("source scripts/android-env.sh && ./gradlew :scanlistKotlin:assembleDebug --console=plain", {
              cwd: REPO,
              shell: true,
            }),
        gradleCold: has("--skip-gradle")
          ? na("skipped (--skip-gradle)")
          : timed(
              "source scripts/android-env.sh && ./gradlew clean :scanlistKotlin:assembleDebug --no-build-cache --console=plain",
              { cwd: REPO, shell: true },
            ),
        unitTests: has("--skip-gradle")
          ? na("skipped (--skip-gradle)")
          : timed("source scripts/android-env.sh && ./gradlew :scanlistKotlin:testDebugUnitTest --rerun --console=plain", {
              cwd: REPO,
              shell: true,
            }),
      },
      rn: {
        metroBundle: existsSync(resolve(REPO, "apps/rn/node_modules"))
          ? timed(
              "npx react-native bundle --platform android --dev false --entry-file index.js " +
                "--bundle-output /tmp/x1-index.android.bundle --assets-dest /tmp/x1-rn-assets",
              { cwd: resolve(REPO, "apps/rn"), shell: true },
            )
          : na("missing apps/rn/node_modules — (cd apps/rn && npm ci)"),
        metroBundleCold: existsSync(resolve(REPO, "apps/rn/node_modules"))
          ? timed(
              "npx react-native bundle --reset-cache --platform android --dev false --entry-file index.js " +
                "--bundle-output /tmp/x1-index-cold.android.bundle --assets-dest /tmp/x1-rn-assets-cold",
              { cwd: resolve(REPO, "apps/rn"), shell: true },
            )
          : na("missing apps/rn/node_modules — (cd apps/rn && npm ci)"),
        jest: existsSync(resolve(REPO, "apps/rn/node_modules"))
          ? timed("npx jest --ci --silent", { cwd: resolve(REPO, "apps/rn"), shell: true })
          : na("missing apps/rn/node_modules — (cd apps/rn && npm ci)"),
        jestCold: existsSync(resolve(REPO, "apps/rn/node_modules"))
          ? timed("npx jest --ci --silent --no-cache", { cwd: resolve(REPO, "apps/rn"), shell: true })
          : na("missing apps/rn/node_modules — (cd apps/rn && npm ci)"),
        // The RN APK is not built on this laptop (aarch64 NDK/CMake prebuilts are x86_64-only, see
        // AGENTS.md "Hard rules"); it comes from CI. Local build time is therefore n/a by design.
        apkLocal: na(
          "not built on this aarch64 laptop by design (native NDK/CMake prebuilts are x86_64-only) — APK comes from CI, see ciJobs",
        ),
      },
      web: {
        viteBuild: existsSync(resolve(REPO, "apps/web/frontend/node_modules"))
          ? timed("npm run build", { cwd: resolve(REPO, "apps/web/frontend"), shell: true })
          : na("missing apps/web/frontend/node_modules — (cd apps/web/frontend && npm install)"),
        vitest: existsSync(resolve(REPO, "apps/web/frontend/node_modules"))
          ? timed("npx vitest run --reporter=dot", { cwd: resolve(REPO, "apps/web/frontend"), shell: true })
          : na("missing apps/web/frontend/node_modules — (cd apps/web/frontend && npm install)"),
      },
      ci: has("--ci") ? ciJobs() : na("pass --ci to pull job durations from GitHub Actions"),
    },
  };

  const frag = resolve(BENCH, "results/fragments");
  mkdirSync(frag, { recursive: true });
  writeFileSync(resolve(frag, "buildtimes.json"), `${JSON.stringify(payload, null, 2)}\n`);

  const show = (label, entry) =>
    console.log(
      `${label.padEnd(26)} ${
        entry.status === "measured" ? `${(entry.wallMs / 1000).toFixed(2)} s` : entry.status === "n/a" ? "n/a" : "FAILED"
      }`,
    );
  const t = payload.tracks;
  show("kotlin gradle (warm)", t.kotlin.gradleWarm);
  show("kotlin gradle (cold)", t.kotlin.gradleCold);
  show("kotlin unit tests (136)", t.kotlin.unitTests);
  show("rn metro bundle", t.rn.metroBundle);
  show("rn metro (cold cache)", t.rn.metroBundleCold);
  show("rn jest (18 suites)", t.rn.jest);
  show("rn jest (no cache)", t.rn.jestCold);
  show("web vite build", t.web.viteBuild);
  show("web vitest", t.web.vitest);
  console.log("-> bench/results/fragments/buildtimes.json");
}

main();
