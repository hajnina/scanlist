# shared/android-embed — EmbeddingGemma 2 for ScanList (card S5)

One Kotlin library that turns text and a camera frame into vectors in the same space, for the Kotlin
app (B1/B3), the React Native module (A3) and the comparison bench.

```kotlin
val embedder = Embedders.create(
    context,
    EmbedderConfig(modelFile = LiteRtEmbedder.defaultModelFile(context)),
)

val items = embedder.embedDocs(listOf("milk", "Oat Milk 3.5%")) // doc prefix from prompts.json
val query = embedder.embedQuery("milk")                        // query prefix from prompts.json
val frame = embedder.embedImage(jpegBytes)                     // no prefix; needs a vision-capable bundle

val score = Vectors.dot(items[0], frame)                       // dims = 256, both unit vectors
```

`Embedder` is the cross-track interface from `docs/ARCHITECTURE.md` plus `embedImage`:

| member | meaning |
|---|---|
| `backend` | `"gpu"`, `"cpu"`, `"npu"` (opt-in) or `"none"` — what the ladder settled on |
| `dims` | length of every returned vector: Matryoshka `dims.active` from `prompts.json` (256 today) |
| `supportsImages` | whether the loaded bundle declares a vision encoder (`ModelInfo.inputModalities().vision`) |
| `embedDocs(texts)` | shopping-list items, **doc** prefix, truncated + L2-normalised |
| `embedQuery(text)` | barcode name / OCR words, **query** prefix, truncated + L2-normalised |
| `embedImage(jpeg)` | raw JPEG, **no** prefix, truncated + L2-normalised |

Blocking and serialised: call from a background thread. The first call loads the model (CPU 1–2 s,
GPU 3–8 s; RECIPE.md §6). Keep one embedder per process (one model resident at a time).

## What is inside

| file | role | copied from |
|---|---|---|
| `Embedder.kt` | the interface + exceptions | spec in `docs/ARCHITECTURE.md` |
| `Vectors.kt` | cosine, L2 norm, Matryoshka truncation | `EmbedGolden.cosine`, `EmbedRunner.finish` (MnemoThera) |
| `Prompts.kt` | reads the bundled `prompts.json`; never hard-codes a prefix | `shared/spec/prompts.json` |
| `GoldenVectors.kt` | CPU reference vectors, `MIN_COSINE = 0.98` | `EmbedGolden.kt` + `embed_golden.json` (MnemoThera) |
| `SelfTest.kt` | ranking + golden proof for every backend | `EmbedRunner.selfTest` (MnemoThera) |
| `BackendHealth.kt` | strikes / block thresholds / clean-close forgiveness | `BackendGuard.kt`, `Accelerators.kt` (MnemoThera) |
| `BackendLadder.kt` | GPU → CPU ladder, skip blocked, strike failures | `BackendLadder.kt` (MnemoThera) |
| `LiteRtEngineFactory.kt` | LiteRT-LM `EmbeddingEngine`, `ModelInfo`, cache dirs | `EmbedRunner.kt`, `LiteRtBindings.kt` (MnemoThera), Google AI Edge Gallery (Apache-2.0) |
| `LiteRtEmbedder.kt` | in-process default implementation | `Embedder.kt` (MnemoThera), reduced |
| `RemoteEmbedder.kt`, `EmbedService.kt`, `EmbedIpc.kt` | opt-in separate-process mode | MnemoThera's `:live`/`:batch` idea (RECIPE.md §2.3), rebuilt as one bound `Messenger` service |
| `assets/prompts.json` | **verbatim copy** of `shared/spec/prompts.json` | shared spec (card S2/S3) |
| `assets/embed_golden.json` | **verbatim copy** of `references/embeddinggemma/src/app/src/main/assets/embed_golden.json` | MnemoThera, recorded on a Pixel 8 CPU run for sha256 `e7a8a220…f4c` |

Attribution comments are kept in every file that carries copied code, with the source path.

## Backend ladder and self-test

1. Candidates: **GPU → CPU**. NPU is *never* automatic; `EmbedderConfig.allowNpu = true` puts it first
   (experimental: the SM8750 bundle fails on 0.18.1/0.19.1, the uncompiled one JIT-compiles for
   140–236 s per open — RECIPE.md §7).
2. Each candidate is constructed, `initialize()`d and **proven**:
   * the self-test query must rank its related sentence above the unrelated one;
   * every vector must match the CPU reference within cosine **0.98**. A backend can rank sentences
     correctly and still return wrong numbers; only the golden comparison catches that.
3. A failure is a **strike**. Two strikes block a backend that was never proven on this device; a
   proven one gets three (transient failures are more likely memory pressure). The **CPU is never
   blocked** — it is the fallback and the reference itself. A clean `close()` clears the strikes of a
   proven GPU/NPU.
4. No golden vectors for the exact model sha256 → GPU/NPU are refused (cannot be proven), CPU loads
   with a warning. `EmbedderConfig.modelSha256` defaults to the shipped bundle's sha256.

State lives in `SharedPreferences("scanlist_embed")`; `BackendHealth.reset()` is “test again”.

## Prompts and dims: read from the spec

`assets/prompts.json` is a copy of `shared/spec/prompts.json`. `Prompts` reads `active`
(`modelcard` today), the matching `doc`/`query` prefixes, `imagePrefix` (always empty), and
`dims.native` / `dims.active` / `dims.matryoshka`. **When card S3 flips `active`, re-copy the file**
(`cp shared/spec/prompts.json shared/android-embed/src/main/assets/prompts.json`) — this library must
not be the place where a prefix is decided.

Rule applied: `prefix + trim(text)`, trimming leading/trailing whitespace only, no case folding.

## LiteRT-LM version decision

`com.google.ai.edge.litertlm:litertlm-android:0.18.1` — the version MnemoThera measured on three
phones. The researched 0.19.1 vision API is **already present in 0.18.1**: `javap` on both AARs shows
the same `EmbeddingEngineConfig(modelPath, backend, visionBackend, audioBackend, cacheDir, modelFd,
maxInputLength, visionTokensPerImage, activationDataType)` and `EmbeddingOptions(normalize,
insertSpecialTokens, outputSize, visionTokensPerImage)`, plus `InputData.Image`. So there was no
reason to bump; image support is used, not gated.

**Kotlin metadata workaround:** 0.18.1 is built with Kotlin 2.4 (`kotlin.Metadata mv=[2,4,0]`), while
the repo root pins Kotlin 2.0.21. This module passes `-Xskip-metadata-version-check` to the Kotlin
compiler (see `build.gradle.kts`). The cleaner fix is a root Kotlin bump (lead-owned); until then this
is the only override, and it is compile-time only.

## Separate process (opt-in)

`Embedders.create(context, config, ProcessMode.ISOLATED)` binds `EmbedService` in
`android:process=":embed"` and talks to it over a `Messenger`. A GPU/NPU driver crash then kills the
engine process, not the app; the next call rebinds and reloads. Default is `IN_PROCESS` (simpler, one
less IPC hop) — card B0 decides whether a real device needs the isolation.

## Not done here (needs a phone)

* No model is downloaded or bundled: `EmbedderConfig.modelFile` is the app's own file, provisioned by
  `scripts/model.sh` (card S6). No `.litertlm` is in git.
* Image embedding is **unverified on a device** (no run has ever embedded a JPEG, RECIPE.md §8):
  card B0 probes `inputModalities().vision` and embeds one frame on GPU and CPU.
* NPU is behind the flag and unproven (RECIPE.md §7.1).
* JVM tests use a fake engine, so the LiteRT-LM calls themselves are only exercised by `assembleDebug`
  and by card B0 on the phone. The `android-embed` native libraries are not run on the aarch64 laptop
  (AGENTS.md: NDK/CMake native builds are CI/device-only).

## Tests

`./gradlew :shared:android-embed:testDebugUnitTest` — plain JUnit, no Robolectric, no Android calls:

* `VectorsTest` — truncate / normalise / cosine maths, 768→256 property, zero vector, size mismatch.
* `PromptsTest` — the bundled spec decision, switching `active`, trim rule, unknown set is an error.
* `GoldenVectorsTest` — the bundled reference is for our sha256; 0.98 boundary and mismatch messages.
* `BackendHealthTest` — 2 vs 3 strikes, CPU never blocked, clean close, reset, per-model records.
* `BackendLadderTest` — open/prove failures fall through, blocked skipped, all-fail error.
* `LiteRtEmbedderTest` — prefixes, 256 truncation + unit norm, image path, text-only refusal, GPU
  fallback, wrong-number GPU struck, no-golden policy, clean close, empty list does not open.
