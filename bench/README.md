# bench/ — the cross-track benchmark harness (card X1)

The same app, built three times (React Native, Kotlin/Compose, Web+server), measured with the same
scripts on the same machine, reading the same 200-item fixture. Output: `bench/results/<track>.json`
plus the raw fragments in `bench/results/fragments/`.

**Read this first:** every number below was produced on the shared aarch64 dev laptop, and the two
native tracks cannot be measured on a phone at all yet (no device on adb — card B0 is blocked).
`n/a` with a reason is a valid, intended result here — not a failure. The card's Done-when says so.

---

## 1. The three-line result

| | Kotlin (apps/kotlin) | React Native (apps/rn) | Web (apps/web) |
|---|---|---|---|
| **rank, 200 items** (p50) | **0.66 ms** (JVM) | 1.38 ms (ts-core in node) | 1.38 ms (same ts-core) |
| **cold start → list visible** | n/a — no device | n/a — no device | **176 ms** (real Chrome) |
| **text embed** | n/a — on-device LiteRT | n/a — on-device LiteRT | **295 ms** cold / **0.04 ms** cached |
| **image embed** | n/a — on-device LiteRT | n/a — on-device LiteRT | **6.4–11.9 s / frame** |
| **artifact** | **142 MB** APK | **291 MB** APK (+1.3 MB JS bundle) | **89 kB** gzip (dist incl. icons) |
| **source code** | 5,448 lines (39% tests) | 6,486 lines (33% tests) | 5,391 lines (29% / 51% tests) |
| **build** | 0.8 s warm / 6.9 s cold | 1.3 s bundle warm / 9.1 s cold | 2.4 s |
| **CI job** | 93 s | **1,142 s** (19 min) | 23 s |
| **agent cost** | 260,743 out-tokens, 11 sessions, 5 PRs | 259,696, 11 sessions, 4 PRs | 275,368, 16 sessions, 4 PRs |

### The headline: image embedding is the divergence

Accuracy is **not** the differentiator — all three implementations agree bitwise on the golden corpus
(min cos 0.999999999996, 146/146) and, as the `sanity` block in each result file shows, they agree
bitwise on this benchmark's top-3 scores too. **Latency is the differentiator.**

The web track embeds a product JPEG in **6.4–11.9 s** on the fp32 CPU path (`apps/web/server/PERF.md`,
card C3). The two native tracks embed on-device through LiteRT. Whatever the phone's real number turns
out to be, it will not be seconds per frame — which means:

- the web track's image scan **cannot** be a live 400 ms camera loop. It has to be on-demand
  ("identify this product") or move to a faster backend (GGUF Q8_0 ≈ 200 ms/image, or WebGPU — card C7);
- text is a different story on web: 295 ms warm single, 44–83 ms/text batched, ~0 ms cached, which is
  usable because item vectors are embedded once per list change, not per tick;
- the native tracks' image latency is **unmeasured**, not zero. It is the single most important number
  this harness still cannot produce.

---

## 2. Measured vs n/a — and why

| Measurement | Kotlin | RN | Web | Oracle | Why the gaps exist |
|---|---|---|---|---|---|
| cold start → list visible | n/a | n/a | **measured** | n/a | Native tracks need a phone on adb (B0 blocked). Web runs in real headless Chrome against `dist/`. |
| embed text p50/p95 | n/a | n/a | **recorded** (PERF.md) | n/a | Native = on-device LiteRT, needs a phone. Web = recorded by card C3; re-running needs a ~2 GB torch venv (disk quota). |
| embed image p50/p95 | n/a | n/a | **recorded** (PERF.md) | n/a | Same; and the oracle needs the model too, so it is not a substitute. |
| rank, 200 items | **measured** (JVM) | **measured** (ts-core) | **measured** (ts-core) | **measured** (python) | The pure ranker runs anywhere. Native number is a JVM lower bound, not an ART number. |
| APK / bundle size | **measured** | **measured** (CI artifact) | **measured** | n/a | RN's APK comes from CI (this laptop cannot run the x86_64-only NDK/CMake prebuilts). |
| LOC | **measured** | **measured** | **measured** | **measured** (shared) | `cloc` is not installed and we cannot sudo; `loc.py` is the documented stand-in. |
| build time | **measured** | **measured** | **measured** | n/a | Local wall clock + CI job durations from `gh api`. |
| agent cost | **measured** | **measured** | **measured** | shared | Tokens from the opencode ledger, attributed by card id in session titles; review/fix evidence from `kanban/lead-log.md`. |

What is *never* n/a by design: the rank benchmark, sizes, LOC, build time and agent cost. What is n/a
today for exactly one reason (no phone): every on-device latency. That is a device gap, not a harness
gap — the scripts are in place for when the phone appears.

---

## 3. How to re-run

Everything is designed to run top-to-bottom from `bench/`:

```bash
cd bench
npm install                                   # esbuild (ts-core bundle) + puppeteer-core (web cold start)
python3 -m venv .venv && .venv/bin/pip install numpy   # oracle rank benchmark

bash scripts/run-all.sh                       # all nine steps, each one degrades to n/a
```

Individual scripts, in dependency order:

| Script | What it produces | Needs |
|---|---|---|
| `scripts/make-fixture.mjs` | `bench/.cache/rank200.txt` — the 200-item fixture all three rankers read | nothing (reads `shared/fixtures/golden.json`) |
| `scripts/rank-ts-core.mjs` | `fragments/rank-ts-core.json` | `bench/node_modules` (esbuild) |
| `scripts/rank-oracle.py` | `fragments/rank-oracle.json` | `bench/.venv` (numpy) |
| `scripts/build-kotlin-driver.sh` | `fragments/rank-kotlin.json` | `./gradlew :scanlistKotlin:assembleDebug` first |
| `scripts/coldstart-web.mjs` | `fragments/coldstart-web.json` | `apps/web/frontend/dist` + Chrome at `/usr/bin/google-chrome` |
| `scripts/sizes.mjs` | `fragments/sizes.json` | the APK/bundle paths (see env vars below) |
| `scripts/buildtimes.mjs` | `fragments/buildtimes.json` | `apps/web/frontend/node_modules`, `apps/rn/node_modules`; `--ci` for CI jobs |
| `scripts/loc.py` | `fragments/loc.json` | nothing |
| `scripts/agent-cost.py` | `fragments/agent-cost.json` | the opencode ledger (optional; degrades to n/a) |
| `scripts/assemble.mjs` | `results/{kotlin,rn,web,oracle}.json` | the fragments |

### The Kotlin side, exactly

```bash
source scripts/android-env.sh                       # aarch64 laptop toolchain (from the repo root)
./gradlew :scanlistKotlin:assembleDebug             # -> apps/kotlin/app/build/tmp/kotlin-classes/debug
node bench/scripts/make-fixture.mjs
bash bench/scripts/build-kotlin-driver.sh           # javac + java against those classes + kotlin-stdlib
```

The driver is `bench/driver/Rank200.java`. Kotlin top-level functions compile to `RankKt` static
methods, so plain `javac` with the `kotlin-stdlib-2.0.21.jar` from the shared Gradle home is enough:
**no kotlinc, no Gradle change, and nothing written outside `bench/`.** That is deliberate — the card
owns `bench/` only.

### Artifact paths for `sizes.mjs`

Both APKs are CI artifacts; download them and point the script at them (paths are read-only inputs,
nothing is copied into the repo):

```bash
gh run download 44023804443 -n scanlist-rn-apk     -D /tmp/x1/rn && \
gh run download 44026921235 -n scanlist-kotlin-apk -D /tmp/x1/kt

X1_RN_APK=/tmp/x1/rn/ScanList-rn-debug.apk \
X1_KOTLIN_CI_APK=/tmp/x1/kt/ScanList-kotlin-debug.apk \
X1_RN_BUNDLE=/tmp/x1/index.android.bundle \
node bench/scripts/sizes.mjs
```

The RN JS bundle is produced by `cd apps/rn && npx react-native bundle --platform android --dev false
--entry-file index.js --bundle-output /tmp/x1/index.android.bundle` (needs `apps/rn/node_modules`,
i.e. `npm ci`; never committed).

---

## 4. What each number means

### rank, 200 items

One **evaluation tick** exactly as `RANK.md` §9 defines it: 200 flattened items × 256-d vectors, 16
text query vectors + 1 image query vector, carried EMA state between ticks. 50 warmup ticks, then 300
measured ticks; p50/p95 by nearest rank (`ceil(p/100·n)-1`).

Three implementations, one workload (`sanity.top3` in each fragment proves it — all three return
`x1:0008 0.922101 / x1:0096 0.920626 / x1:0184 0.919466`):

| | p50 | p95 | runtime |
|---|---|---|---|
| Kotlin (`apps/kotlin/.../rank/Rank.kt`) | 0.66 ms | 0.87 ms | JVM 25, desktop — **lower bound** for ART |
| ts-core (`shared/ts-core/src/rank.ts`) | 1.38–1.51 ms | 1.6–1.7 ms | node 22 (V8) — lower bound for Hermes |
| oracle (`shared/ref/scanlist_ref.py`) | 1.59 ms | 1.62 ms | python 3.14 + numpy 2.5 (matmul) |

The Kotlin port wins because it does one tight float64 loop per item with no allocation of an
intermediate matrix; the oracle is close behind because numpy's matmul is vectorised; ts-core sits in
between with scalar loops over plain arrays. All three are far inside the 400 ms tick budget — **rank
time was never the bottleneck.** Embedding is.

One caveat worth stating plainly: `apps/kotlin` still implements the *pre-S10* `decideTop` (no
margin/no-match gate), so on this workload it returns a hero (`x1:0008`) where ts-core and the oracle
correctly return `null` (top-1 − top-2 margin is 0.001475 < `M_text` 0.05). Scores and order are
bit-identical; only the highlight decision differs, and it is the documented B3-sync gap. `decideTop`
is timed separately and costs < 1 µs, so this does not affect the comparison.

### The fixture

`make-fixture.mjs` builds 200 items from the **real** EmbeddingGemma 2 vectors pinned in
`shared/fixtures/golden.json` (cycling the 88 item vectors, ±0.08 deterministic basis-vector offset per
item so no two items are byte-identical — otherwise identical top scores close the ±margin gate and no
list ever gets a hero). Names come from the golden corpus with a section suffix, every 13th item is
`done`, and the queries are 16 real text vectors + 1 real image vector. Deterministic, no model call,
identical on every machine.

### cold start → list visible (web)

`coldstart-web.mjs` serves `apps/web/frontend/dist` same-origin, launches **a fresh headless Chrome
profile per run** (cold cache, cold service worker), seeds `shared/spec/samples/van-weekly.json` into
the app's own localStorage keys, then measures two marks from `page.goto` start:

- **shell visible** — `.library-button` on screen: **115 ms p50** / 131 ms p95
- **list visible** — first `.item` rendered with height > 0 after opening the list: **176 ms p50** /
  190 ms p95 (n=7)

This is the pattern of `apps/web/frontend/scripts/smoke-e2e.mjs` (read-only, not edited) applied to
measurement instead of assertions. Caveat: localhost, no network latency; a real phone over 4G adds
the download of ~89 kB gzip (whole dist incl. icons) plus TLS.

### embed latency (web, recorded)

Taken from `apps/web/server/PERF.md` (card C3, measured 2026-11-17 on this laptop with the real model,
fp32 CPU torch path), with the file as provenance rather than a re-run — the torch venv is ~2 GB and
this laptop's disk quota was purged once already for space. Headline values:

| operation | median |
|---|---|
| 1 text, cache miss | 295 ms (p90 475, max 573; n=30) |
| 1 text, cache hit | 0.04 ms |
| 43 texts batched | 44–83 ms/text (1.9–3.6 s per request) |
| 1 product JPEG, cache miss | **7.2 s** (6.4 / 6.7 / 7.7 / 7.9; second run 8.3–11.9) |
| HTTP `/embed/image` cold | 6.8–8.0 s |
| model load | 2.3 s (load + first encode 4.4 s) |

`web.json` marks this block `"status": "recorded"` and carries the same table so the comparison reads
from one file. Re-running it is one command on a machine with the venv (PERF.md's "Reproduce" section).

### sizes

| | bytes | notes |
|---|---|---|
| Kotlin APK (local) | 149,205,160 (142.3 MB) | 73.7% `lib/` (4 ABIs), 24.0% dex, 1.6% assets |
| Kotlin APK (CI) | 149,319,907 (142.4 MB) | independent build, same size to 0.08% |
| RN APK (CI) | 304,797,440 (290.7 MB) | 87.6% `lib/` — React Native's own .so per ABI |
| RN JS bundle | 1,296,555 (1.24 MB) | `--dev false`, and it needs the whole RN runtime to interpret it |
| web `dist/` shipped | 230,393 raw / 90,716 gzip | JS 166,931 → 42,094 gzip, CSS 15,516 → 3,558 gzip, plus icons/PWA shell (source map 493 kB excluded) |

Per-ABI (why both APKs are fat — all four ABIs are packaged, including x86 emulators):

| ABI | Kotlin `lib/` | RN `lib/` |
|---|---|---|
| x86_64 | 41.9 MB | 82.7 MB |
| arm64-v8a | 36.4 MB | 77.9 MB |
| x86 | 16.9 MB | 58.2 MB |
| armeabi-v7a | 9.6 MB | 35.9 MB |

An arm64-only split would roughly halve both. That is a product decision (which devices ship), not a
track difference — the numbers above are what CI actually produces today.

### LOC

`loc.py` is a `cloc` stand-in: it counts non-blank, non-line-leading-comment lines and splits
**source vs test** (the split matters — Kotlin's parity suite is 39% of its code):

| area | files | code | source | test | test share |
|---|---|---|---|---|---|
| `apps/kotlin` | 54 | 5,448 | 3,347 | 2,101 | 38.6% |
| `apps/rn` | 87 | 6,486 | 4,338 | 2,148 | 33.1% |
| `apps/web/frontend` | 26 | 3,049 | 2,188 | 861 | 28.2% |
| `apps/web/server` | 13 | 2,342 | 1,153 | 1,189 | 50.8% |
| `shared/` | 44 | 6,246 | 4,124 | 2,122 | 34.0% |

The web track's total (5,391) is the only one that needs a *second* language and process (Python +
torch on a server) to match what the other two do on-device. The RN track's 6,486 lines are the
smallest amount of *own* logic (it imports ts-core instead of porting a ranker) but still the largest
surface, because the scan stack (VisionCamera, ML Kit, Nitro module) is wired through it.

### build time

| | warm | cold cache | test suite |
|---|---|---|---|
| Kotlin `assembleDebug` | 0.8–0.95 s | **6.9 s** (`clean --no-build-cache`, 56/56 tasks executed) | 136 tests in 1.4–1.7 s |
| RN metro bundle | 1.3 s | **9.1 s** (`--reset-cache`) | 18 suites / 146 tests in 1.8 s (6.4 s `--no-cache`) |
| Web `npm run build` (tsc + vite) | 2.2–2.4 s | — | vitest 2.0–2.4 s |

CI job durations (from the runs whose artifacts are measured above, `gh api .../jobs`):

| track | CI job | duration |
|---|---|---|
| kotlin | `kotlin` | **93 s** |
| rn | `rn` | **1,142 s** (19 min 02 s) |
| web | `web` | **23 s** |

Dependency download time is excluded everywhere (node_modules and the Gradle home were warm). The RN
APK is never built on this laptop by design: the aarch64 toolchain's NDK/CMake prebuilts are
x86_64-only, so RN's native build is a CI-only measurement.

### agent cost

The one metric without a stopwatch. Two independent sources:

1. **opencode session ledger** (`~/.local/share/opencode/opencode.db`, read-only): tokens per session,
   attributed to a track by the card id in the session **title** ("Build card B3 in worktree",
   "Adversarial review of PR 19 (B3)"). On the free tier `cost` is 0.00 for every session, so
   **output tokens** are the comparable unit — they are what the model actually wrote.
2. **`kanban/lead-log.md`** (committed): merged PRs, REQUEST-CHANGES verdicts, `-sync` convergence
   rounds, infrastructure deaths — regex-counted, with the prose left as the evidence.

| track | sessions | output tokens | cards | merged PRs | REQUEST-CHANGES | tokens / merged PR |
|---|---|---|---|---|---|---|
| kotlin | 11 | 260,743 | 8 | 5 | 1 | 52,149 |
| rn | 11 | 259,696 | 6 | 4 | 3 | 64,924 |
| web | 16 | 275,368 | 8 | 4 | 1 | 68,842 |
| shared (S-cards) | 23 | 418,830 | 10 | 5 | 5 | 83,766 |
| unattributed (research, premortem, fresh re-reviews) | 7 | 259,261 | — | — | — | — |

Honest limits, stated once and repeated in the JSON: tokens measure agent **output**, not human
wall-clock; a track needing more output did not necessarily take more time. Attribution is regex on
titles, so sessions with no card id land in `unattributed` (a real project cost, not a track's). The
ledger is a lower bound (it only holds sessions this machine still has — `sessions.coverage` in
`agent-cost.json`). The most interesting signal is not the totals, which are close, but the *shape*:
the RN track burned its budget on **review rounds** (3 REQUEST-CHANGES for 4 merged PRs) while Kotlin
spent it on **parity work** (a 39% test share, a 1,114,112-code-point casefold fuzz, and still needed
B3-sync to catch up with a spec change that landed under it).

---

## 5. Files

```
bench/
├── README.md                    this file
├── package.json                 esbuild + puppeteer-core (dev only)
├── .gitignore                   node_modules/, .cache/, .venv/, driver output
├── driver/Rank200.java          JVM driver over the Kotlin app's compiled rank classes
├── scripts/
│   ├── make-fixture.mjs         the 200-item fixture (from shared/fixtures/golden.json)
│   ├── rank-ts-core.mjs         ts-core rank benchmark (node)
│   ├── rank-oracle.py           python oracle rank benchmark
│   ├── build-kotlin-driver.sh   javac + java the Kotlin driver
│   ├── coldstart-web.mjs        real-Chrome cold start (fresh profile per run)
│   ├── sizes.mjs                APK / bundle / dist sizes + per-ABI and per-component breakdown
│   ├── buildtimes.mjs           build + test wall clock (+ CI job durations with --ci)
│   ├── loc.py                   cloc stand-in, source/test split
│   ├── agent-cost.py            opencode ledger + lead-log evidence
│   ├── assemble.mjs             fragments -> results/<track>.json (the only place n/a is decided)
│   └── run-all.sh               all of the above, non-fatal per step
└── results/
    ├── kotlin.json rn.json web.json oracle.json     the four track files
    └── fragments/*.json                             raw per-measurement output (committed as evidence)
```

`bench/.gitignore` keeps `node_modules/`, `.cache/`, `.venv/` and compiled driver classes out of git.
No weights, no APKs, no bundles are ever committed: the APKs are CI artifacts downloaded to `/tmp`.

---

## 6. Known gaps (what X1 could not measure, and when it becomes measurable)

1. **On-device latency for both native tracks** — cold start, text/image embed, and the real rank time
   on ART/Hermes. Blocked on the phone (card B0). The rank driver and the golden fixtures are ready;
   what is missing is a device, not code.
2. **Web embed latency re-run** — recorded from PERF.md with provenance instead of re-executed, because
   the torch venv is ~2 GB and the disk quota is tight. `PERF.md`'s "Reproduce" section is the recipe.
3. **Web cold start over a network** — the measured 176 ms is localhost; the real-user number adds
   download + TLS. Measuring that needs a deployed endpoint (DEPLOY.md).
4. **A first build with cold dependencies** — every build number here excludes `npm ci`/Gradle
   dependency download (they were already warm). Those are network-bound and vary by machine, so they
   are deliberately out of scope rather than silently mixed in.
