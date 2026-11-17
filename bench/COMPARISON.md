# ScanList — which implementation wins

**Verdict: Kotlin (`apps/kotlin`).** For an offline-first phone-camera shopping list, Kotlin is the only
track that combines an on-device image-embedding path with a 142 MB artifact, a 0.8 s warm build and a
93 s CI job. RN wraps the same engine in a 291 MB app with a 19-minute CI-only build; web is the cheapest
to ship but its image scan costs **6.4–11.9 s per frame** on a server. **Provisional:** no phone has run
the native image path (B0).

*Snapshot: `origin/main` `28e7c7f`, 2026-11-17. A6 (RN polish) and B7 (Kotlin polish) were still open;
the web C2-follow-up merged after the X1 benchmark and its deltas are folded in below.*

## Pick-a-track summary

| Decision input | Kotlin | React Native | Web |
|---|---|---|---|
| Interactive image scan, offline | plausible, **unmeasured** | plausible, **unmeasured** (same engine) | **no** — server round-trip, 6.4–11.9 s/frame |
| Barcode / OCR scan | yes | yes | yes |
| Solo-dev loop | **0.8 s warm build / 93 s CI** | 19 min CI-only APK | **2.4 s build / 23 s CI** |
| Artifact | 142 MB APK + 462 MiB model | 291 MB APK + 462 MiB model | **211 kB** main JS + 1.93 GB server |
| Own code | 5,448 lines‡ | 6,486 lines‡ | 5,391 lines‡ |
| Tests on main | 296 | 237 | 291 (+150 shared ts-core, +130 server) |
| Review / retry cost | **1 RC** | 2 RC merged; A6 open | 1 RC + **8 infra deaths** |

Sources: `sizes`, `loc`, `buildtimes`, `agent-cost`, `coldstart-web`, `PERF.md`, cards (`B5`, `A5`, `C5`,
`X1`), `lead-log.md`. Details and full paths below.

## The three tracks

| | Kotlin | React Native | Web |
|---|---|---|---|
| Stack | Kotlin 2.0.21 + Compose/M3 Expressive | React Native 0.88 + Paper | Preact + @material/web PWA |
| Ships as | Android APK | Android APK (repo) | PWA, any modern browser |
| Model | on-device LiteRT (GPU→CPU auto; NPU experimental) | on-device LiteRT via Nitro (same Kotlin engine) | Python/torch server, fp32 CPU |
| Ranker | Kotlin port of RANK.md | shared `ts-core` | shared `ts-core` in the browser |
| In one line | native app, all local | JS app over the same native engine | thin client + embedding server |

Sources: `kotlin.json` / `rn.json` / `web.json` (`implementation`); `docs/ARCHITECTURE.md`.

## Performance

| Measurement | Kotlin | React Native | Web |
|---|---|---|---|
| Rank 200 items, p50 / p95 | **0.66 / 0.80 ms** (JVM*) | 1.38 / 1.47 ms (node*) | 1.38 / 1.47 ms (node*) |
| Cold start → list visible | n/a — no phone (B0) | n/a — no phone (B0) | **176 / 184 ms** (Chrome, n=7, localhost) |
| Text embed | n/a — on-device LiteRT, no phone | n/a — same | **295 ms** miss / **0.04 ms** hit |
| Image embed | n/a — on-device LiteRT, no phone | n/a — same | **7.2 s** median (6.4–11.9 s range) |
| Build, warm / cold | 0.8 / 6.9 s | 1.3 / 9.1 s bundle (APK is CI-only) | 2.4 s |
| CI job | **93 s** | **1,142 s** (19 min) | **23 s** |

\* JVM/node lower bounds, not ART/Hermes. The JVM ranker is faster than ts-core in node here; the phone
numbers are unmeasured. The Kotlin snapshot predates B3-sync (stale `decideTop`), so its hero differs on
this fixture; `decideTop` is timed separately (<1 µs) and does not affect rank time.
All three are far inside the 400 ms tick budget — **ranking was never the bottleneck; embedding is.**
Sources: `rank-kotlin.json`, `rank-ts-core.json`, `coldstart-web.json`, `buildtimes.json`; oracle reference
1.59 ms p50 (`rank-oracle.json`).

## The headline: image embedding is the divergence

- **Web:** one product JPEG is **7.2 s median** (6.4 / 6.7 / 7.7 / 7.9; second run 8.3–11.9 s), 6.8–8.0 s
  over HTTP, 10.7 s in the container; model load 2.3 s (`PERF.md`). Text is usable: 295 ms cold, 44–83
  ms/text batched, 0.04 ms cached.
- **Cache nuance:** the server caches by image sha256, so repeated frames of the same shelf are free; a
  live camera stream is not. C4's uploader keeps one POST in flight and drops replaced frames, so the
  queue never stacks — but every new product still costs seconds.
- **Native:** both tracks run the same LiteRT engine on-device, so there is no network round-trip. Latency
  is **unmeasured** (B0); `docs/ARCHITECTURE.md` also calls on-device *image* embedding unverified.
  Unmeasured is not the same as fast.
- **C7's browser finding:** fp16 text works (22 ms/doc batched, 45.6 ms warm single, parity min cos
  0.99994), but it needs a **543–878 MB** download and a hard WebGPU gate; q4/q8 device-lost, and the
  vision pass hung >600 s. Verdict: embeddings stay server-side. Browser text beats the server's 295 ms
  cache-miss but never its 0.04 ms cache hit.

Sources: `PERF.md`, `web.json` (`embed` block), `C7.md`, `lead-log.md` (C7 merge).

## Accuracy: not the differentiator

- **146/146 golden vectors** reproduce at min cos **0.999999999996**; all three rankers return
  identical top-3 scores on the 200-item fixture (`bench/README.md`; each result's `sanity` block).
- S3's quality numbers: text top-1 **1.000** on both prefix sets (verbatim-query ceiling), image **0.923**
  (mnemothera) / 0.769 (modelcard) — `lead-log.md`.
- **Gap: no wrong-highlight rate.** The premortem asked X2 for one; the only mitigation measured is 14
  distractor queries (all below the text accept line). The external prior is weak for image-only search
  (fused Recall@1 0.076, image-only 0.029 on a 5k-product benchmark — `lead-log.md`). 146/146 says the
  implementations agree; it does not say the model is right in a supermarket.
- Bench artifact: the Kotlin snapshot returns a hero where ts-core/oracle return `null` (pre-S10
  `decideTop`). That is a stale gate, fixed by B3-sync (merged), not a model-accuracy difference.

## Size, code, build

| | Kotlin | React Native | Web |
|---|---|---|---|
| Shipped artifact | **142.3 MB** APK (149,205,160 B; CI 142.4) | **290.7 MB** APK (304,797,440 B) + 1.24 MB JS | **211.13 kB** main JS / 58.40 kB gzip; whole dist 230,393 B / **90,716 B gzip*** |
| Model weights | 462 MiB (484,622,336 B), separate | 462 MiB, separate | 1.49 GB weights + 1.93 GB server image |
| Code (source / test) | 5,448 (3,347 / 2,101)‡ | 6,486 (4,338 / 2,148)‡ | 5,391 (3,341 / 2,050)†‡ |
| Tests (last main) | 296 | 237 | 291 + 150 ts-core + 130 (+1 skip) server |

\* The 90.7 kB gzip is the whole dist incl. icons at the X1 branch point, **before** the scan UI; the
post-scan whole-dist gzip was not re-measured. Main-JS gzip went from 42.52 kB (pre-scan, `buildtimes`)
to 58.07 kB (merged scan UI, `C5.md`) and 58.40 kB after the C2-follow-up (`lead-log.md`). APK sizes
labelled MB use binary MB (MiB), matching `bench/README.md`; the byte counts are quoted so the decimal
value is recoverable.
† Frontend 3,049 + server 2,342. APKs are fat (all four ABIs); an arm64-only split would roughly halve
both (`bench/README.md`). Both native tracks need the 484,622,336 B model separately, so total install is
APK + 462 MiB. Test counts are the last recorded on main per suite, not one commit.
‡ LOC is the X1 harness snapshot, the only same-script, same-day count across the three tracks. It
predates the B5/A5 scan UIs, the C4/C5/C7 web scan work and the C2-follow-up, so current main is larger on
all three; `bench/scripts/loc.py` recomputes it. Treat the row as a shape, not a current total. Sources:
`sizes`, `loc`, `C5.md`, `PERF.md`, `docs/ARCHITECTURE.md`, `lead-log.md`.

## Bugs, retries, review traffic

| | Kotlin | React Native | Web |
|---|---|---|---|
| REQUEST-CHANGES verdicts | 1 (B5) | 2 merged (A1, A4-sync); A6 open† | 1 (C4) |
| Cards needing a second round | 3 of 6 done (B3, B4, B5) | 3 of 5 done (A1, A4, A5) | 3 of 8 done (C2, C4, C5) |
| Infra deaths | 0 recorded | 1 | 8 |
| Fleet-caught builder bugs (early tally) | 1 (B1 manifest) | 2 (A1 haptics, A1 types) | 1 (C1) |

† A6 (RN settings/polish) and B7 (Kotlin polish) were **open** at writing. No numeric count above
includes them: `agent-cost.json` (X1 snapshot) also counts A6's first round, while this table counts
merged verdicts only (2). The web C2-follow-up is merged and counted. A "second round" means a formal
REQUEST-CHANGES round, a `-sync`/follow-up round, or a re-land after a failed closeout. The early 6-bug
tally also includes one shared card (S6) and one process card; later review rounds caught the bugs below.

What the rounds caught:

- **Kotlin:** B5's late OFF answer painted the wrong barcode's strip, OFF backoff was missing, then the
  image drain loop (`while(true)`) starved TICK/OCR/OFF; B6 could open two self-test engines and needed a
  run mutex. Both fixed with tests/mutations (`B5.md`, `lead-log.md`).
- **RN:** A5's `runTick` cleared the OCR batch before ranking, so OCR never reached the ranker; A1's
  haptics were silent; A4 joined OCR lines against the spec; A5-OFF-sync ported Kotlin's retry/redirect
  semantics (`A5.md`, `lead-log.md`).
- **Web:** C4 applied the repeat filter after the 16-line cap (suppressed lines ate slots, fixed by
  C4-sync); C5 opened the first-imported list and had a scroll-blind FLIP (re-landed); C2's URL import
  had no timeout and dropped index entries orphaned docs — **fixed by the merged C2-follow-up**
  (`C4.md`, `C5.md`, `done/C2.md`).
- **Process incidents (project-level):** the tag plague (two sources: `main:main` DWIM refspecs and a CI
  rolling tag named `main`; PR #32 renamed it `rolling`, AGENTS rule added); PR #34 (C5 approved but
  never merged; re-landed as PR #37); lane starvation (B5, above) — `lead-log.md`.

Sources: `lead-log.md` (per-card verdicts, rounds, incidents, early tally); `agent-cost.json` (infra
deaths, card totals); `kanban/done/*.md` (each round's evidence).

## Agent cost

*X1 ledger snapshot (before A5-OFF-sync and the C2-follow-up); a lower bound, not the final tally.*

| | Kotlin | React Native | Web |
|---|---|---|---|
| Sessions | 11 | 11 | 16 |
| Output tokens | 260,743 | 259,696 | 275,368 |
| Tokens / merged PR | 52,149 | 64,924 | 68,842 |
| Recorded $ | 0.00 (free tier) | 0.00 | 0.00 |

Parity: **~260–275k out-tokens**. Plus shared 418,830 (23 sessions, 5 PRs) and unattributed 259,261 (7
sessions). `$/feature` is not computable: the ledger records 0.00 on the free tier and the repo has no
price list, so tokens are the unit. The shape differs more than the totals: Kotlin spent on parity (39% of
its X1-snapshot code is tests), RN on review rounds (2 merged RC + 1 open), web on 8 infra deaths. Sources:
`agent-cost.json`, `bench/README.md`, `lead-log.md`.

## Maintainability

- **Build loop:** Kotlin 0.8 s warm / 6.9 s cold locally; web 2.4 s; RN 1.3 s for the bundle but the APK
  is CI-only (NDK/CMake prebuilts are x86_64-only) at 19 min per run. Kotlin's local build needs the
  hand-built aarch64 setup in `scripts/android-env.sh` (aapt2 override); CI uses stock Maven aapt2. For a
  solo dev, RN's loop is the worst.
- **Dependency weight:** RN's APK is 87.6% native `.so` (267 MB across four ABIs); Kotlin's native libs
  are 110 MB (LiteRT + ML Kit), also across four. Web has no install but the server is 1.93 GB (torch) +
  1.49 GB weights; zxing-wasm adds 1.04 MiB and Tesseract a lazy 23 kB chunk (`C4.md`).
- **Tests:** Kotlin 296 (X1 snapshot: 39% of code is tests), RN 237 (33%), web 291 + 150 ts-core + 130
  server (38% test share across frontend+server at the same snapshot).
- **UX feel:** all three implement the same M3 Expressive brief (hero card, big tick, chips, springy
  reorder). Native tracks have real haptics/springs; RN uses Animated/LayoutAnimation (not Reanimated,
  documented); web uses FLIP + `navigator.vibrate` with a fallback. Neither native track has run on a
  phone (B0), and web has only headless-Chrome evidence; only web has real screenshots (`C5.md`). UX feel
  is unranked.
- **Offline:** Kotlin/RN run the model on-device; web's PWA shell and lists survive offline, but any
  uncached text or image embedding needs the server. That is the requirement that decides the verdict.

Sources: `buildtimes`, `sizes`, `loc`, `bench/README.md`, `C4.md`, `C5.md`, `lead-log.md`.

## Verdict

Kotlin wins for this project. The deciding requirement is offline phone-camera scanning: Kotlin is the
only track that pairs the on-device engine with a 142 MB artifact, a local 0.8 s build, a 93 s CI job and
a native M3 UI. RN wraps the same engine and pays 2× the APK, a 19-minute CI-only build and the most
review traffic (2 merged RC verdicts, a third open at writing) for no measured advantage. Web is the best
shipping experience — 211 kB, 176 ms cold start, 23 s CI — and the worst scan experience: 6.4–11.9 s per
image, server required.

**Strongest counter-argument — and it is not RN, it is web.** Kotlin's core advantage is unmeasured. No
phone has run the native image path, and `docs/ARCHITECTURE.md` calls on-device image embedding
unverified. If B0 finds LiteRT image embedding slow or unsupported, the native tracks lose the feature
that justifies their size and toolchain, and web is dramatically cheaper to build, ship and iterate.
Web's image path could also move to the GGUF Q8_0 backend (~200 ms/image, a research-digest estimate
cited in `PERF.md`, not measured here) or be used on-demand; barcode + OCR text already works at 295 ms.
Web is also the only artifact here that runs on an iPhone today. If Martin weights reach and solo-dev
velocity over offline image scanning, web is the rational pick. The verdict is therefore **"Kotlin,
pending one phone measurement"**, not "Kotlin proven".

**What would change it:** B0 showing the native image path works (confirms Kotlin) or fails (web);
accepting on-demand, network-required image scans (web); or deciding Android-only is unacceptable (web).

## What this cannot tell you

- Native cold start, text and image embed: **n/a**, no phone on adb (B0). The harness and fixtures are
  ready.
- Wrong-highlight rate: **not measured**; the golden corpus is small and the text queries are verbatim
  names.
- Post-scan whole-dist gzip: **not re-measured** after the scan UI entered the bundle; the 90,716 B
  figure is the pre-scan whole dist.
- Web cold start over a real network: 176 ms is localhost; a phone over 4G adds download + TLS.
- Agent cost: output tokens from a free-tier ledger, attributed by card id in session titles; a lower
  bound.
- A6 (RN settings/polish) and B7 (Kotlin polish) were **open** at writing; nothing above depends on their
  code.

## Sources

- `bench/results/{kotlin,rn,web,oracle}.json`
- `bench/results/fragments/{sizes,loc,buildtimes,agent-cost,coldstart-web,rank-kotlin,rank-ts-core,rank-oracle}.json`
- `bench/README.md`; `apps/web/server/PERF.md`; `docs/ARCHITECTURE.md`; `bench/scripts/loc.py`
- `kanban/done/{X1,A1,A4,A5,B5,B6,C2,C4,C5,C7}.md`; `kanban/lead-log.md`
