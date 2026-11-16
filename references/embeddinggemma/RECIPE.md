# EmbeddingGemma 2 on Android (NPU / GPU / CPU): recipe lifted from MnemoThera

Written 2026-11-16. Tags: **[REPO]** verified by reading code/docs in the repo, **[WEB]** reported online (not run by us), **[LOG]** a measurement quoted from the repo's own docs/logs (we did not re-run it).

## 0. Source of truth and repo differences

- Source of truth: `/home/martin/projects/Therapy_local` (HEAD `6ddb886`, 2026-11-16). Copies in `src/` here come from it. The older `/home/martin/projects/therapy-app` (HEAD `f4d6bbf`, 2026-11-11) was read first, then re-checked.
- **Embed code is byte-identical in both**: `embed/Engines.kt`, `Embedder.kt`, `EmbedGolden.kt`, `engine/runner/EmbedRunner.kt`, `models/Accelerators.kt`, `NpuRuntime.kt`, `LiteRtBindings.kt`, `EmbedProbeActivity.kt`, `BackendProbeActivity.kt`, `BackendGatesTest.kt`, `ModelsInventoryTest.kt`, and AD-01/02/06/09, CONNECT_PHONE, pixel8-2026-11-07.md.
- Differences that touch the embedder neighbourhood (none change embedding logic):
  - `config/AppConfig.kt`: `EmbeddingConfig` unchanged. New: `WINDOW_CUT_VERSION`, TRANSLATE/LOCALIZE constants, and `EngineTuning.progressLogMs` (30 s) + `whisperTimeoutMs`. `progressLogMs` writes `engine_call_progress` every 30 s during a long call, added because the NPU embedder open is a 140-236 s on-device compile that looked like a hang (PR #99).
  - `memory/LiveCues.kt`: only adds the `Display` (translation of shown facts) hook. Cue ranking/embedding identical.
  - `models/ModelSpec.kt`: only adds the Whisper q8_0 spec and `speechFor(workflow)`. `EMBED` spec and `BACKEND_BUILDS` (still only Gemma E2B/SM8750) unchanged: **no EmbeddingGemma NPU file is in the catalogue in either repo**.
  - `app/build.gradle.kts`: only `GIT_COMMIT` build field, QA app label, and the `verifyNoQaApiInRelease` task. Dependencies identical.
  - Therapy_local adds AD-10..21 (AD-19: Gemma E2B GPU FLOAT32; AD-21: GPU/NPU use the same model as CPU), `docs/QA_API.md` (adb `embed` command with `--backend npu`), whisper.cpp JNI, iOS port. AD-19 holds the newest embedder GPU table (2026-11-13), copied below.
  - The CI branch `ci/embed-aot-sm8750` (not merged into main; `git show 8662417`) has `scripts/embed-aot.sh` + workflow: copied to `scripts/`.

## 1. Runtime and delegate per backend  [REPO]

One runtime for everything: **LiteRT-LM**, Kotlin `com.google.ai.edge.litertlm.EmbeddingEngine` (not MediaPipe, not llama.cpp, not ONNX for the embedder; ONNX/sherpa is only used for Canary ASR + diarization).

| Backend | How it is requested | What it needs |
|---|---|---|
| CPU | `Backend.CPU()` | the model file only. Always the last fallback, never blocked, is the golden-vector reference. |
| GPU | `Backend.GPU()` (OpenCL via LiteRT-LM GPU delegate) | same model file as CPU (`embeddinggemma-2-740m.litertlm`). Manifest: `<uses-native-library android:name="libOpenCL.so" android:required="false"/>` and `libvndksupport.so` (see `src/AndroidManifest.xml`). |
| NPU (Qualcomm only) | `Backend.NPU(nativeLibraryDir = context.applicationInfo.nativeLibraryDir)` | `libLiteRtDispatch_Qualcomm.so`, `libQnnHtp.so`, `libQnnSystem.so` in the native lib dir (from the two Maven AARs below, `useLegacyPackaging = true`) AND a model bundle built for the SoC. Not working cleanly, see section 7. |

Bindings are in `models/LiteRtBindings.kt`; the ladder order/priorities in `models/Accelerators.kt` (NPU 100, GPU 200, CPU 1000, plus opt-in NNAPI for ONNX only).

Engine construction (`engine/runner/EmbedRunner.kt`, the essential 15 lines):
```kotlin
EmbeddingEngine(EmbeddingEngineConfig(
    modelPath = file.path,
    backend = LiteRtBindings.backend(context, name),   // CPU / GPU / NPU
    audioBackend = if (textOnly) null else Backend.CPU(), // audio encoder pinned to CPU (Gallery does the same)
    cacheDir = File(context.cacheDir, "emb_t$maxTokens").path, // one cache dir per input size
    maxInputLength = maxTokens,                         // 128..8192, powers of two
)).also { it.initialize() }   // blocking, 1-8 s GPU, up to minutes on NPU: run off the main thread, in a separate process
val v = engine.computeEmbedding(listOf(InputData.Text(prefixed)),
    EmbeddingOptions(normalize = true, insertSpecialTokens = true, outputSize = 768)).embedding
```
`ModelInfo.from(path)` reads the bundle: `inputModalities()` (text/audio/vision flags), `maxContextTokens()`, `supportedBackends(Modality.TEXT)`, `npuBrand`, `socName`. The app lowers `maxTokens` to the reported context.

## 2. Selection and fallback  [REPO]

`Embedder.loadLocked()` -> `Accelerators.order(modelId, LITERT)` -> `BackendPolicy.order(...)` (auto = NPU, GPU, CPU; debug override puts one id first and keeps CPU last) -> `BackendLadder.load(...)` (copied: `models/BackendLadder.kt`, `BackendGuard.kt`). For each candidate in order:
1. `Accelerators.unavailable()` gate: NPU only if the three native libs exist AND a validated model file for this SoC exists (`NpuRuntime.modelReason`); GPU/CPU always. Since AD-08 there is **no free-memory gate** (Pixel 8 doc of 2026-11-07 predates that and shows the old "not enough free memory" skip).
2. `open` = construct + `initialize()` + **self-test** inside the engine process: ranks 3 fixed sentences (query "my boss keeps criticising my work" vs related/unrelated) AND compares each output to CPU "golden" vectors of the same model file (`assets/embed_golden.json`, keyed by the model sha256, `EmbedGolden.MIN_COSINE = 0.98`). A backend that returns wrong numbers is struck. No golden for the file -> every GPU/NPU is refused, CPU loads with an error log.
3. Failure = exception or the engine process dying -> `BackendGuard` records a strike (2 strikes = blocked; clean unload clears), next backend. The engine lives in an isolated Android process (`:live` for text+audio, `:batch` for text-only), so a native crash on GPU/NPU kills only that process (AD-01). IPC via Binder/AIDL (`engine/` package, not copied; not needed for a small app, but the process isolation is the reason a bad GPU driver does not take the app down. For scanlist a simpler version: run the engine in a `android:process=":embed"` service, or at least wrap init in try/catch + keep a "last crashed backend" flag in SharedPreferences).
4. Reload on the CPU after memory pressure; `Embedder.close()` is deferred while a call is in flight.

Debug/QA: `BackendPolicy.override = "GPU"; BackendPolicy.force = true` skips guard blocks. `EmbedProbeActivity`/`BackendProbeActivity` (copied) drive it over adb:
`adb shell am start -n com.therapylocal.app.qa/com.therapylocal.app.debug.EmbedProbeActivity --es backend NPU --ez force true --es tag npu` -> `files/out/embedprobe_<tag>.json`.

## 3. Model files  [REPO unless noted]

HF repo: `litert-community/embeddinggemma-2-740m-litert-lm` (Apache-2.0). Format: LiteRT-LM bundle `.litertlm` (single file with tokenizer + text encoder + audio and vision encoders; quantisation not stated in the repo, ship as-is, "quantized" per [WEB]).

| File | Bytes | sha256 | Use |
|---|---|---|---|
| `embeddinggemma-2-740m.litertlm` | 484,622,336 | `e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c` | CPU + GPU (the catalogue `ModelRegistry.EMBED`). URL: `https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/main/embeddinggemma-2-740m.litertlm` |
| `embeddinggemma-2-740m_Qualcomm_SM8750.litertlm` | 543,522,816 | `ac1973c0195dc6e28a621651f2f5e04d35fdc7a7b11cdbbe94f29f5dccb57996` | official NPU build for Snapdragon 8 Elite. **Fails** with litertlm-android 0.18.1 and 0.19.1 (section 7). |
| `embeddinggemma-2-740m_NPU_Uncompiled.litertlm` (rev `66011bd4f00a8b36a1d3c4ae7bf908b4891b4881`) | not recorded | `9cb5b084e34dc528f43c947eec81eff020be0dc79ce155f2497c3f2efa92e94f` | NPU source bundle; runs on NPU but is JIT-compiled at every open (140-236 s). Input for the AOT script. |
| `embeddinggemma-2-text-270m.litertlm` / `..._Qualcomm_SM8750.litertlm` | 164,626,432 / 187,596,800 | n/a | text-only 270M variants. Seen on the phone in `phone-NPU-server/LOGBOOK.md` E20 (excerpt in `docs/`); **not run**. Different vector space from the 740M (but same 768 dims, do not mix). |

- Dims: 768 native. Max sequence 8192 tokens shared across modalities; the LiteRT build has fixed input sizes `INPUT_SIZES = 128,256,...,8192`, the app opens the smallest that fits (text pipeline 2048, live audio 1024). Buffers and GPU memory scale with it.
- Matryoshka: the app can pass `EmbeddingOptions.outputSize` (it sets 768; `EmbeddingConfig.DIM` says change it to 512/256/128). [WEB] model card: 768/512/256/128, re-normalise after truncation, quality near-lossless to 256, 128 hurts multimodal.
- Audio: 16 kHz mono WAV, 25 tokens/s (`AUDIO_TOKENS_PER_SECOND`), ~327 s max. Not needed for scanlist.
- Download: the app's resumable checksummed downloader (`ModelSetup`, not copied) into `getExternalFilesDir(null)/models/embeddinggemma-2-740m/`. Pinned size+sha256 in `ModelRegistry.EMBED` (copied `models/ModelSpec.kt`). Housekeeper rule: use `scripts/resumable-download.sh URL DEST 484622336 e7a8a220...` on the laptop.
- Push to phone: `adb push embeddinggemma-2-740m.litertlm /sdcard/Android/data/<pkg>/files/models/embeddinggemma-2-740m/`. **Gotcha**: if the target dir was created by `adb shell mkdir -p` (owner shell) the app cannot see/open the file (`Failed to open LiteRT-LM file`); let the app create the dirs first (any probe run does), then push only the file. Also never `adb push folder/` onto an existing folder (creates `models/models/`). Scripts used on the Pixel 8: `scripts/pixel8/push_model.sh`, `run_probe.sh`.
- Not copied (weights): the three `.litertlm` files above.

## 4. Gradle / native libs  [REPO: `src/app/build.gradle.kts`]

```kotlin
implementation("com.google.ai.edge.litertlm:litertlm-android:0.18.1")             // the engine (Kotlin API + native libs; GPU via OpenCL, needs Kotlin 2.4 metadata)
implementation("com.google.ai.edge.litert:litert-npu-runtime-qualcomm:2.3.0")     // libLiteRtDispatch_Qualcomm.so + compiler plugin (Apache-2.0)
implementation("com.qualcomm.qti:qnn-runtime:2.50.0")                             // libQnnHtp.so, libQnnSystem.so, HTP skels (Qualcomm AI Stack licence). ONE QAIRT version (2.50.0) must match the bundle, else "Unsupported context binary version"
```
Build env: AGP 8.8.0, Kotlin 2.4.0 (required by LiteRT-LM), compileSdk/targetSdk 34, minSdk 31, `ndk { abiFilters += "arm64-v8a" }`, `packaging { jniLibs { useLegacyPackaging = true; excludes += listOf("**/libQnnGpu.so","**/libQnnDsp*.so","**/libQnnHtpV68*.so") } }`. APK 73.7 MB -> 136.7 MB with the NPU libs (`libQnnHtpPrepare.so` alone 85 MB). **If scanlist only wants GPU+CPU, drop the last two dependencies and the NPU code: APK stays small.** Manifest also needs `libcdsprpc.so` `uses-native-library` for NPU (comes merged from the Qualcomm AAR). Newer versions exist on Maven (litertlm-android 0.19.1, npu-runtime 2.3.2), but see section 7. Docs check [WEB]: LiteRT-LM Kotlin `EmbeddingEngineConfig(modelPath, backend, visionBackend, audioBackend, cacheDir, modelFd, maxInputLength, visionTokensPerImage, activationDataType)` and `EmbeddingOptions(normalize, insertSpecialTokens, outputSize, visionTokensPerImage)` (github.com/google-ai-edge/LiteRT-LM, `EmbeddingConfig.kt`).

## 5. Task prompt prefixes

- **In the repo [REPO]** (`config/AppConfig.kt`): `QUERY_PREFIX = "task: search query | text: "`, `DOC_PREFIX = "task: search result | text: "`, applied as `prefix + text.trim()`; `insertSpecialTokens = true`. Audio gets no prefix (the `role` argument only matters for text).
- **Google's model card [WEB]** (ai.google.dev/gemma/docs/embeddinggemma/model_card_2): query `task: search result | query: {query}`, document `title: {title} | text: {content}` (`title: none` when absent), QA `task: question answering | query: ...`, `task: classification | query:`, `task: clustering | query:`, `task: sentence similarity | query:`, code `task: code retrieval | query:`. **Images, video and audio take no prefix.**
- **Conflict**: the repo's strings differ from the model card (repo uses `search query | text:` / `search result | text:`; card uses `search result | query:` / `title: ... | text:`). The repo's strings follow LiteRT-LM's `embedding_models` page per its code comment, which says "each uses `text:`". Not resolved by us. For scanlist: build a tiny golden retrieval test (a handful of shopping items and queries) and compare both prefix sets before choosing; the card's format is the one Google trains with.

## 6. Measured latencies  [LOG: from repo docs, Pixel 8 numbers from 2026-11-07, POCO/tab from 2026-11-13]

EmbeddingGemma 2 740M, text only, median ms per call, short sentences, litertlm-android 0.18.1, cosine vs CPU vectors:

| Phone (SoC) | CPU | GPU | cos GPU vs CPU | load CPU / GPU |
|---|---|---|---|---|
| POCO F8 Pro (SM8750, Adreno) | 69 (75) | 33 (36) | >= 0.9996 | 1.3 s / 6.2 s |
| Galaxy Tab S7 (SM8250) | 116 | 104 | >= 0.9974 | n/a |
| Pixel 8 (Tensor G3, Mali-G715), input 2048 | 250-270 | 109-114 | >= 0.9996 | 1.1-2.2 s / 3-8 s |
| POCO F8 Pro NPU, uncompiled bundle | n/a | n/a | not measured | NPU load **140-236 s** (compile on every open), per call **12-18 ms** (claimed from ingest log, "not exact") |

Sources: `docs/AD/AD-19.md` (GPU table), `docs/measurements/pixel8-2026-11-07.md`, `docs/AD/AD-09.md` (CPU on POCO 56-96 ms per call, load 546-620 ms), `research/asr-llm-combo/log/transcript-notes/tl-f3cc06b4-...ad18.md` in Therapy_local (NPU row). The laptop has no embedder measurements. Image latency: **none in the repo** (the app never embeds images).

## 7. Known gotchas / bugs

1. **NPU embedder is the fragile one [REPO, AD-09]**: official `..._Qualcomm_SM8750.litertlm` fails in `EmbeddingEngine.initialize` on 0.18.1: `QNN op validation failed: 'Gather_5' (type=Gather)` (EmbeddingLookup unsupported), `Input tensor 2 lacks data`, `Failed to invoke the compiled model`. With litertlm-android 0.19.1 + npu-runtime 2.3.0/2.3.2: `undefined symbol` LiteRtDispatchQueryInterface / `No usable Dispatch runtime found`, then `Failed to allocate tensors` (the Maven dispatch libs export only the older API). Branch `experiment/embedgemma-npu-runtime` in therapy-app. Workaround found later (commit 2c1b5dc): QA-only `files/models/npu/embed_override.txt` names the bundle to load on the NPU; the **Uncompiled** bundle loads but compiles at every load (140-236 s), unusable for an interactive app. AOT compile recipe (CI, x86_64 only, litert-torch 0.10.0, QAIRT 2.50.0.260828, `litert_lm_npu_compiler --backend=qualcomm --soc_model=SM8750`) is in `scripts/embed-aot.sh`; **result (output sha, on-device test) is not recorded anywhere we found**. flutter_gemma [LOG in AD-09, reported] sees NPU vectors at cosine ~0.83 mean vs CPU for the 270M, which would fail the 0.98 golden proof. Verdict: treat NPU for EmbeddingGemma as experimental; GPU+CPU is the shippable pair. NPU is Qualcomm-only; Tensor G3 has no path here.
2. **GPU precision [WEB]**: model card says never use float16, use bf16/float32. The repo's embedder GPU path passed with default settings (cos >= 0.9996), unlike the Gemma LLM which needed `ActivationDataType.FLOAT32` (AD-19, `GpuPrecision.kt`). `EmbeddingEngineConfig` has `activationDataType` if a device misbehaves.
3. **adb push ownership** (section 3). **Always load in a separate thread/process**: GPU init 3-8 s, NPU minutes; watchdog logs `engine_call_progress`.
4. Memory: GPU load on a 7.5 GB Pixel 8 dropped MemAvailable to ~0.3-0.6 GB (no kill seen); one model resident at a time (`Engines.suspend()` before loading the LLM).
5. Audio encoder forced to CPU (accuracy/perf); for a text/image app the audio encoder can be skipped (`audioBackend = null`, ModelInfo check `m.audio` only when needed). Audio-stripped bundles exist, so read `inputModalities()` before assuming.
6. `computeEmbedding` returns an already normalised vector with `normalize = true`; the app still re-normalises defensively. Use dot product = cosine.
7. Cache dir per `maxInputLength` (`emb_t<N>`): reusing one dir across sizes is wrong (copied from Gallery).
8. Qualcomm licence clause 2.e (high-risk uses) and APK +63 MB: see AD-09. LiteRT `minSdk` 31 in the repo.
9. The self-test golden file is tied to the exact model file sha256: if scanlist uses another bundle, regenerate with BackendProbeActivity `--es backend CPU --ez golden true` (copy of `embed_golden.json` is for sha `e7a8a220...` only).

## 8. EmbeddingGemma 2 and images: **yes, it exists and is multimodal including images**  [WEB]

- Google DeepMind, announced ~2026-10-07 (fonearena dated 7 Oct 2026; the official model card gives no date). HF `google/embeddinggemma-2` (full precision, Apache-2.0); on-device `litert-community/embeddinggemma-2-740m-litert-lm`. Built on Gemma 4. 740M total = 130M transformer + 140M embeddings + 170M vision encoder + 300M audio encoder; text-only is ~270M. Maps text, code, **images**, video, audio into one 768-d space (Matryoshka 512/256/128). Context 8,192 tokens shared; image default 280 tokens/image (up to ~29 per input), vision budget 70..1120 tokens, **no prefix for images**. Quantised memory on Pixel 11 Pro: ~191 MB text-only, ~567 MB full. Benchmarks on card: MMEB v2 Image Hit@1 57.28, MIEB-lite 65.67 (no plain image-text retrieval score).
- Runtimes: the card lists Sentence Transformers/Transformers; the launch post lists MediaPipe, LiteRT, llama.cpp, Ollama, LM Studio, vLLM, MLX, transformers.js. Android = LiteRT-LM (what MnemoThera uses). The LiteRT-LM docs (developers.google.com/edge/litert-lm/embedding_models) show a Kotlin image example: `InputData.Image(bytes)` with `visionBackend = Backend.GPU()` and `computeEmbedding(listOf(item))`. Laptop-side: `ggml-org/embeddinggemma-2-GGUF` and `unsloth/...` GGUFs exist (LOGBOOK E20; Ollama `embeddinggemma-2` pulled on Oracle, 768 dims, text only verified).
- **Not verified by us**: no image embedding was ever run in MnemoThera (only Text and Audio `InputData`); whether the 485 MB CPU/GPU `.litertlm` actually contains the vision encoder on this build (`ModelInfo.inputModalities().vision` is logged in `model_info` by `EmbedRunner`: check it first on the phone); image latency; whether the image path works on GPU/NPU; the `visionTokensPerImage` knob. First scanlist task: a probe like `EmbedProbeActivity` that logs `model_info` and embeds one JPEG with `visionBackend = Backend.GPU()` and `Backend.CPU()`, then compares to text embeddings of "milk", "bread" etc.
- Scanlist implication: one model gives text<->image in one space, so a camera photo can be ranked directly against list-item text. Expect image tokens (280 default) to dominate cost; test lowering `visionTokensPerImage`.

## 9. Alternatives if EmbeddingGemma image path disappoints  [WEB, none run by us]

- **SigLIP 2** (Google): LiteRT conversions exist: `litert-community/SigLIP2-base-patch16-224` and community `mlboydaisuke/SigLIP2-base-patch16-224-LiteRT` (reported ~60 ms/image steady state on a Pixel 8a GPU, FP16, all ops GPU-native); Qualcomm AI Hub `qualcomm/SigLIP2` (text encoder ~4.5 ms on Galaxy S22 QNN). Separate image + text towers, shared space: the cleanest text<->image option on Android with a published LiteRT path. Needs its own tokenizer for the text tower.
- **MobileCLIP2** (Apple, arXiv 2508.20691): MobileCLIP2-B 79.4 ImageNet top-1 vs SigLIP-B/16 76.0; best accuracy/latency on paper (iPhone numbers). No Android LiteRT conversion found; PyTorch/open_clip only, so you would convert it yourself.
- **Gemma 3n / Gemma 4 E2B vision encoders**: generative multimodal LLMs (Gemma 4 E2B/E4B ~150M vision encoder, LiteRT-LM files `litert-community/gemma-4-E2B-it-litert-lm`). They are not trained as a shared retrieval embedding space; no source found that exposes one. Do not use them as embedders. (EmbeddingGemma 2 reuses the Gemma 4 family's encoders and *is* the retrieval-trained version.)
- Practical order: (1) EmbeddingGemma 2 740M via LiteRT-LM GPU (one model, one engine, already proven for text on 3 phones); (2) SigLIP 2 base/LiteRT if image quality or latency is bad; (3) MobileCLIP2 only if you accept a conversion project.

## 10. What is in this folder

- `src/` (verbatim, same relative paths, from Therapy_local): `embed/{Engines,Embedder,EmbedGolden}.kt`, `engine/runner/{EmbedRunner,NpuBundleCheck,GpuPrecision}.kt`, `models/{ModelSpec,Accelerators,NpuRuntime,LiteRtBindings,BackendLadder,BackendGuard}.kt`, `config/AppConfig.kt` (EmbeddingConfig, BackendPolicy), `memory/LiveCues.kt`, qa probes, `BackendGatesTest.kt`, `ModelsInventoryTest.kt`, `assets/embed_golden.json` (25 KB reference vectors for sha e7a8a220...), `AndroidManifest.xml`, `app/build.gradle.kts`, root `build.gradle.kts`, `gradle.properties`. They do not compile standalone (they use `AppLog`, `EngineHost`, IPC); read them as a reference and port `EmbedRunner`'s core + `BackendLadder` logic.
- `docs/`: AD-01, 02, 06, 09, 19, 21; MEMORY.md, DEVELOPMENT.md, CONNECT_PHONE.md, LOGGING.md, QA_API.md; `measurements/pixel8-2026-11-07.md`; `LOGBOOK-E20-excerpt.md`.
- `scripts/`: `embed-aot.sh`, `embed-aot.yml` (CI branch, not main), `pixel8/*.sh` (adb push/run probe; device serial hardcoded to the Pixel 8).
- Not copied: `.litertlm` weights (484,622,336 / 543,522,816 B, and the Uncompiled bundle), keystores.

## 11. Sources (web)

- Model card: https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2
- LiteRT HF page: https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm
- LiteRT-LM embedding docs: https://developers.google.com/edge/litert-lm/embedding_models ; source `EmbeddingConfig.kt`/`EmbeddingEngine.kt` in https://github.com/google-ai-edge/LiteRT-LM
- Launch coverage: https://www.fonearena.com/blog/494313/google-embeddinggemma-2.html
- SigLIP 2 LiteRT: https://huggingface.co/litert-community/SigLIP2-base-patch16-224 , https://huggingface.co/mlboydaisuke/SigLIP2-base-patch16-224-LiteRT , https://huggingface.co/qualcomm/SigLIP2
- MobileCLIP2: https://arxiv.org/pdf/2508.20691
- Gemma 4 on LiteRT-LM: https://ai.google.dev/edge/litert-lm/models/gemma-4
