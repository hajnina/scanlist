# ScanList — plan

Goal: the same app three times (React Native, Kotlin, Web+server), built in parallel by cheap opencode agents
(default model `opencode/deepseek-v4.1-flash-free`), then compared on the same golden tests and benchmarks.

## Phases
| Phase | What | Parallelism |
|---|---|---|
| 0 Foundation | shared spec, fixtures, reference ranker, Embedder interface, Kotlin embed module | S-cards, mostly parallel |
| 1 Skeletons | each track builds + shows a static list from JSON | A/B/C fully parallel |
| 2 Lists | import, nested render, tick/persist/export | parallel per track |
| 3 Embeddings | embedder wired, item vectors cached, golden ranking test green | parallel per track (A+B depend on S5) |
| 4 Scan magic | camera, barcode→OFF lookup, OCR, live re-rank, hero card | parallel per track |
| 5 Polish | M3 Expressive pass, settings/backends, error states | parallel |
| 6 Compare | bench harness, COMPARISON.md (latency, size, LOC, cost, bugs found) | after tracks done |

## Cost strategy
- Cards are small (≤ ~2 h agent work), self-contained, list exact files they own and their acceptance test → cheap models succeed.
- Each card names the reference files to read, so agents don't explore the whole repo.
- Hard cards are marked `difficulty: hard` (native NPU/GPU work, RN native module); give those a stronger model
  or a human review if DeepSeek fails twice.
- Tracks never touch each other's folders → no merge conflicts between parallel agents.
- Verification is objective: every track must pass `shared/fixtures/golden.json` with the same ranker semantics.

## Risks / open
- EmbeddingGemma 2 image path is reported online but unverified on device → B0 probe first; SigLIP 2 fallback.
- Android builds on this aarch64 laptop need the toolchain at `~/projects/martins-whisper/android-toolchain`
  (aapt2 override, see references/bonsai-ui/src/bonsai-serve/build.sh). RN on aarch64 Linux may need the same overrides.
- No phone on adb right now; device tests (NPU/GPU) need the phone plugged in.
- Open Food Facts lookup needs network; cache results; offline = OCR only.
