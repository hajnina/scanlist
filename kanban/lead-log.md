# Lead log — decisions, triage, corrections

Running log of the lead's triage (review reports, research digests) so decisions survive across sessions.

## 2026-11-16 — dunning-kruger premortem report (ses_e1a3f413dffeP2gDvVSFatFtDE)

Verdict: CONTINUE WITH CORRECTIONS. Triage by evidence:

**Must-fix now (applied same day):**
- `pr.yml` web zip escaped the workspace (`../../../../` from apps/web/frontend) → upload could never find the artifact. FIXED in pr.yml + main.yml (three levels up).
- CI was green-but-vacuous: a PR changing a track with no build entrypoint exited 0. FIXED: changed to hard `exit 1` ("card not done") for kotlin/rn/web; ts-core hard-fails if `src/` exists without package.json.
- No CI job built `shared/**`. FIXED: `shared` filter + job (ts-core npm test; `:shared:android-embed` build+JVM tests once root gradle + module exist) in both workflows; release job now depends on it.
- Card contradictions (verified): S3 owned nothing in shared/spec but edits prompts.json → added `shared/spec/prompts.json` to S3 owns. S5's Done-when needs a root gradlew that nobody owned → new card **S9** (gradle root wiring, depends S7) + S5 depends now [S1, S9]. A3's TurboModule registration seam (MainApplication wiring + settings.gradle include live in A1's paths) → A3 owns now include the registration files + a dev screen path.
- ARCHITECTURE.md said images are "~280 tokens" on device — verified wrong: the LiteRT bundle is provisioned for 70/140 (280 is the HF/ONNX default). Corrected in ARCHITECTURE.md + B0 must probe 140 and 70.
- ARCHITECTURE.md fallback said SigLIP 2 LiteRT — research shows it is image-tower-only (separate space, poor fusion fit). Corrected: MediaPipe tasks-retrieval UniversalEmbedder (same .litertlm) is the fallback.

**Note-and-continue (re-check at next gate):**
- No numeric accuracy bar anywhere → S3 card now requires top-1 ≥ 0.80 + ≥8 "not on the list" distractor queries where nothing may be highlighted. Review S3's PR against that bar.
- 400 ms / EMA α=0.5 / hysteresis 0.02 are uncalibrated (overprecision risk). Do not edit card S1 while ag-s1 is building; at S1 review/merge, add "v1 defaults — X1 bench revises" framing to RANK.md if the builder didn't.
- Image-only discrimination is the weakest signal (elastic 5k-product benchmark: fused Recall@1 0.076, image-only 0.029) → the distractor queries in S3 are the direct mitigation; X2 comparison should include a "wrong highlight rate" metric.
- Laptop→device vector transfer tolerance: golden fixtures are fp32 HF; device bundle is int4/int8 QAT. B0/S5 self-tests use cos ≥ 0.98 per backend — keep per-backend golden vectors on the roadmap (S5 note covers API; revisit after B0 numbers).
- License conflict (HF card says Apache-2.0, MediaPipe Semantic Retriever page says Gemma license) → Martin decides before any weights leave the machine; releases ship APKs only for now.
- No phone on adb; B0/S6 stay blocked-until-phone as written.

**Context (no action):**
- METR RCT base rate (AI-assisted experienced devs 19% slower) — expectation-setting for the fleet, not a verdict on this setup (cheap models, tiny cards, objective Done-whens).
- "30 PRs outlast patience" → for Martin to timebox; X2 is the readout.

**Discarded as noise:** none — every finding came with citations or file:line.

## 2026-11-16 — web/RN research digest applied
- Lead notes added to C3 (llama.cpp #30054 recipe + /embedding trap + TEI dead end + sentence-transformers shape), C4 (BarcodeDetector status + zxing-wasm + dual-target frame sampler), A4 (VisionCamera v5 + mlkit plugin + throttle + frame→JPEG routes). New card C7 (browser WebGPU embedding spike, depends C2).
- Full notes (outside repo): /home/martin/projects/scanlist-research/research_notes/ScanList prior art and parallels/

## 2026-11-17 — B1 merged; free-usage-limit interruption handled
- PR #9 (B1) merged on APPROVE-WITH-NITS: S9 contract clean (no second root, no plugin pins), theme fidelity verified line-by-line vs STYLE_GUIDE, build re-run green in a fresh clone, CI green on exact head. Nits applied: CAMERA/INTERNET removed from the stub manifest (least privilege; B4 card now carries the re-add note + module-dep-pin guidance); screens-split refactor deferred to B2/B4/B5/B6 as opportunistic.
- Five agents (S3, C8, C6, S5 builders + A1 reviewer) died on the free-usage limit mid-card; all five restarted with re-orientation prompts (verify-what-exists, never redo downloads, resume to PR-open → stop). Worktrees retained partial work — no conflicts observed.
- B2/B4 became READY on B1 done; dispatch HELD deliberately until ≥1 restarted agent completes, to not exceed the concurrency that just exhausted the free budget (5-6 active).
- Fleet-caught lead CI bugs: still 3. Fleet-caught builder bugs: 4 across 10 reviews (S6 push path, C1 pytest+barcode, card-text glob, manifest perms) + 2 REQUEST-CHANGES-free rounds saved by nit-fix-at-merge.

## 2026-11-16 — A1/B1 build round (lead actions)
- PR #8 (A1, RN skeleton) builder-flagged the third lead-authored CI bug: RN "Rename APK" step used `apps/rn/android/**/outputs/...` in a shell `mv` — `**` is not globstar in Actions bash → run red even though the APK build succeeded (4m48s, all ABIs). FIXED with the literal `apps/rn/android/app/build/outputs/apk/debug/*.apk` in pr.yml + main.yml; PR #8 close+reopened to pick up the new snapshot (rerun-reuses-old-snapshot quirk).
- Builder also asked for arch-aware build-tools pick in android-env.sh — already implemented earlier (S9 round); noted so nobody re-does it.
- Score: fleet-caught lead bugs = 3 (web zip path, vacuous-green semantics, `**` glob) — the adversarial-review loop is paying for itself.
- B1 (PR #9) + A1 (PR #8) both green locally with CI evidence; RN 0.88.1 and Compose/M3 1.4.0 both proven buildable on the aarch64 laptop via android-env.sh + on x86_64 CI.

## 2026-11-16 — PR #7 (S2 ref ranker) merged
- Review: APPROVE-WITH-NITS. Reviewer re-ran the suite (74 green, pinned versions), mutation-tested it (EMA flip → 8 red, hysteresis → 1 red, boost removal → 3 red — suite live), differential-tested vs a literal §9 transcription: 4000/4000 ticks, 0 divergences; flatten ids/docTexts/cache keys all independently reproduced; determinism sha1-stable across 3 processes.
- Lead fixes applied: (1) requirements.txt pinned numpy==2.5.5/pytest==9.2.0 (with a regen-note), (2) dead EMA_ALPHA constant now actually used (`q6(EMA_ALPHA*raw + (1-EMA_ALPHA)*prev)`, bit-identical at 0.5 — X1 can retune one constant), (3) `flatten()` no longer emits `vec: None` — reviewer's cross-track hazard; contract clarified: vec lives on rank() INPUT items only, per RANK.md §1 (docstring updated, suite re-run 74 green).
- vec contract written into S3's card notes (golden.json serialization must not add vec to flattened arrays).
- 74/74 green after fixes (fresh venv, pinned versions).

## 2026-11-16 — S9/S6/C1 build round (lead actions)
- PR #4 (S9) flags applied by lead before B1 dispatch: CI kotlin job now builds via root wrapper `./gradlew :scanlistKotlin:assembleDebug` (module id + projectDir apps/kotlin/app is now a cross-card contract; B1 must not pin plugin versions or add its own settings.gradle).
- S7-reviewer's predicted RISK materialized: build-tools auto-pick grabbed x86_64 build-tools/37.0.0. FIXED arch-aware in scripts/android-env.sh (newest dir whose aapt2 ELF is aarch64; SCANLIST_BUILD_TOOLS override warns if non-aarch64). Verified: resolves 35.0.1, CI-sim exit 0.
- C1 flag applied: CI web job split — frontend build (skip when no package.json, hard-fail if src/ exists without it) + new "Server tests" step (pytest from requirements.txt/pyproject.toml; hard-fail if server code exists without declared deps).
- GitHub quirk learned: `gh run rerun` reuses the OLD workflow snapshot from the merge ref — to re-run a PR against a NEW workflow, close+reopen the PR (done for PR #5).
- android-env.sh remains S7-owned but patched by lead post-done (same as reviewer-recommended lead fix); recorded here for provenance.

## 2026-11-16 — camera→list prior art digest applied
- S3 Done-when rewritten: TEXT top-1 ≥ 0.80 hard bar; IMAGE top-1 measured (external R@1 evidence 35–44, arXiv 2603.17186) + recommended top1/top2 margin rule; ≥8 distractor "not on list" queries.
- Lead notes on B5/A5/C5: manual-tick consensus, margin rule, sticky scan-mode, one-decision-per-pass patterns.
- S3 lead note: closest parallel pipeline (Smart-Fridge, no licence — patterns only), Instacart patent US12217236B2 FTO note for Martin, Tandoor Commons-Clause copying trap.
- Confirmed: NO public project re-ranks a list by camera similarity (the only GitHub description match was this repo itself, minutes old).

## 2026-11-16 — PR #1 (S7) merged
- Adversarial review: APPROVE-WITH-NITS; all builder claims reproduced. Nits applied by lead: card Done-when glob reworded to $ANDROID_AAPT2; README section from card Notes placed in README.md; `_scanlist_android_env` leftover function accepted (harmless).
- Low RISK noted: build-tools auto-pick is "newest dir", only checks -x; `SCANLIST_BUILD_TOOLS` env overrides — revisit if the toolchain gains a non-version dir.
- NDK native builds cannot run on this aarch64 host (NDK prebuilts are x86_64-only) → CMake/NDK-dependent cards must verify via CI (ubuntu runners are x86_64). Added to AGENTS.md.
- AGP end-to-end unproven until first app card; watch B1/A1 PRs for the gradle-vs-CI interplay.
