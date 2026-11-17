# C7 — EmbeddingGemma 2 in the browser (transformers.js + WebGPU) vs the server round-trip

**Status: spike complete. Measurements are real, taken with the real model on this laptop's GPU —
text fully measured, vision blocked (never returns), and NOT on a phone.**

Read §2 before quoting any number. The card's Done-when allows desktop-only numbers *if said loudly* —
this document does that, and marks every number with the device and dtype it came from.

> **NO PHONE WAS AVAILABLE.** There is no adb device in this environment (card B0 is blocked), so
> nothing here is a Chrome-on-Android number. The machine that produced the numbers below is a
> Snapdragon X Elite laptop whose GPU (Adreno 7xx) is the same family Android flagships use, which
> makes the numbers *directionally* useful and **not** a substitute for a phone run. Re-run this page
> on the phone (C6 HTTPS + Chrome) before treating any latency as a shipping decision.

---

## 1. Verdict (what the lead can act on)

**Recommendation: keep embeddings on the server for now. Browser embedding is measurably fast for
text (5× the server's cache-miss) but carries a 543–878 MB download plus a hard WebGPU gate, the
dtype the model card recommends (q4, 284 MB) is unusable on this GPU, and the vision encoder never
returned a vector in 10 minutes. Do not build the browser image path on this evidence.** The C4 seam is
the right place to leave the door open: `createFrameUploader({ embed })` in
`src/scan/sources/uploader.ts` takes the image embedder as an injected `embed: (frame) =>
Promise<ImageEmbedding>` behind its single-flight, newest-frame-wins queue — today that function POSTs
to `/embed/image`, and a local C7 embedder would be a drop-in swap (no such local embedder exists yet;
this spike's page is not wired into it).

| Path | Where | Why |
| --- | --- | --- |
| Item docText vectors (44 per list, cached at import) | **server**, cached | Already built (C3): 44 texts ≈ 2–3.6 s once per list, then 0.04 ms. The browser cannot beat *cached* and costs 543 MB to try. |
| OCR/barcode text queries (per 400 ms tick) | **server**, warm | C3: 110–155 ms warm. Browser fp16 measures 48–58 ms (§4.3) — 2–3× faster, but that only matters if the 400 ms tick is ever the bottleneck, which it is not. |
| One-shot image embedding ("identify this product", photoless items) | **server** (unchanged) | Browser side is **not demonstrated**: with fp16 (the only dtype that runs here) the vision encoder did not finish the first call in a single **600 s** run (§4.4; one 600,037 ms attempt, not a repeat). Server is 6.4–11.9 s/JPEG on CPU. Until a phone run returns a real per-image number, the browser is not an option for images at all. |
| Live camera stream (2.5 fps) | **neither** | 280 tokens/image, a batch cap of 9 images, and an unmeasured (here: non-returning) vision pass. The C3 guidance stands: opportunistic single frames, barcode/OCR text in between. |

Why not fully client-side: fp16 costs **878 MB** (text+vision) or 542 MB (text) versus the server's
zero, needs WebGPU (q4/q8 lose the device here, §4.2; WASM cannot create a q4 session at all, §5),
and loses to a cached server vector on every repeat. Why not fully server-side: nothing in the
measurements justifies paying the image path's 6–12 s/frame on a CPU host if a phone can do it
locally — but this spike could not show that a phone can.

**What would change the recommendation** (in order): (1) a phone run of this page that returns a
real per-image latency and image parity for fp16 or q4 — if that number is ≲ 1 s, revisit the image
path; (2) evidence that q4/q8 work on Android's Chrome/GPU stack, since that is the 284 MB tier that
makes the download tolerable; (3) a product decision that a 543 MB download is acceptable, which is a
business call, not a benchmark.

---

## 2. Environment (read this before quoting §6)

| | |
| --- | --- |
| Device | **Snapdragon X Elite laptop** (`/sys/class/drm/card1`: `qcom,x1e80100-dpu`), aarch64, 8 visible cores, 30 GB RAM |
| GPU | Adreno 7xx (WebGPU adapter `qualcomm/adreno-7xx`, `maxBufferSize` 4 GiB, `shader-f16` present) via Vulkan |
| Browser | **Google Chrome 154.0.8037.57**, `--headless=new`, Linux |
| Flags | `--enable-unsafe-webgpu --use-angle=vulkan --enable-features=Vulkan` (WebGPU was **not** adapter-available without them in headless; a real desktop Chrome session has it on by default from 121) |
| WebGPU | `navigator.gpu` present, `requestAdapter()` → hardware Adreno adapter, `requestDevice()` OK |
| Library | `@huggingface/transformers@4.3.1` loaded from jsDelivr at runtime (not in `package.json`) |
| Model | `onnx-community/embeddinggemma-2-ONNX` (Apache-2.0), vision encoder loaded, audio dropped; `dtype` tried: **q4** (model-card default), **q8**, **fp16** (the only one that runs here — §4.2/§4.3) |
| Output | 768-d native → first 256 components → L2-normalised (RANK.md §2, same as `embedder_gemma.py`) |
| Golden reference | `shared/fixtures/golden.json` (`google/embeddinggemma-2` fp32 CPU, rev `f9972ac…`) |

**This is not a phone.** No Android device was reachable (`adb` empty; B0 blocked), so there is no
Chrome-on-Android number anywhere in this document. The GPU is the same *family* as Android
flagships (Adreno 7xx) but the CPU, memory bandwidth, thermals and browser build are a laptop's.

### Verified independently while writing this card

- `@huggingface/transformers@4.3.1` exists on npm (published 2026-10-07) and serves
  `dist/transformers.web.js` as ESM from jsDelivr; ONNX Runtime Web's WASM/JSEP binaries come from
  the same CDN by default.
- `onnx-community/embeddinggemma-2-ONNX` file sizes (HF Hub API, 39 files): text `q4` =
  `model_q4.onnx_data` 174.0 MB + graph 0.5 MB = **174.5 MB**; vision `q4` = 109.0 + 0.2 MB =
  **109.2 MB**; together **283.7 MB**, exactly the "text-only 175 MB / text+vision 284 MB" in the
  research digest. The model card's own table says 175 + 109 MB. `tokenizer.json` is another
  32.2 MB, so a cold text+vision run pulls ≈ **316 MB**.
- Selective loading works as documented: `config.vision_config = null` → text-only; the audio
  encoder (189 MB at q4) is always dropped here (`config.audio_config = null`), because the
  `feature-extraction` pipeline would otherwise load every encoder.
- The model card's traps are real and are pinned in unit tests (§7): 2,700-token WebGPU batch limit,
  280 tokens/image, `[[a],[b]]` vs `[a,b]`, no prefix on images, re-normalise after truncation.

---

## 3. What was built

Under `apps/web/frontend/src/embed-spike/` (dev-only, **not** part of the production bundle):

| File | Role |
| --- | --- |
| `index.html` | Standalone page. `npm run dev` → `/src/embed-spike/index.html`. `vite build` only takes the root `index.html` as input, so this page and transformers.js never enter `dist/`. |
| `page.ts` | UI + `window.__c7` driver (`run()`, `loadModel()`, `session`, `photo()`, `golden()`, `probe()`) for headless/CI-less measurement. |
| `model.ts` | The real session: CDN import, `AutoConfig`/`AutoModel`/`AutoTokenizer`/`AutoProcessor`, progress-callback accounting, adapter probe, preprocessing-vs-forward-pass stage logs. Weights go to the **browser cache**, never to git. |
| `harness.ts` | Measurement orchestration through the `EmbedSession` seam: token counting, batching, cold/warm timings, image batches, parity vs golden, trap checks, one stage log line per step and an optional per-call watchdog. |
| `budget.ts` | Prefix + token-budget rules (`prefixesFromSpec`, `docInput`, `queryInput`, `planBatches`, 2700/280/9 constants). |
| `vectors.ts` | `truncateAndNormalize` (truncate **then** normalise, float64), cosine, compensated sum, timing stats. |
| `fixtures.ts` | Loads `shared/spec/prompts.json`, `shared/fixtures/golden.json` and the fixture JPEGs through Vite — same bytes the Python oracle embedded. |
| `session.ts` | The seam + report types (`EmbedSession`, `LoadMetrics`, `SpikeReport`). |
| `*.test.ts` | 26 vitest tests over the pure parts; the real model load is the manual run, never CI. |

### Running it

```bash
cd apps/web/frontend
npm ci
npm run dev            # vite
# open http://localhost:5173/src/embed-spike/index.html
# or headless (what produced §6):
#   chrome --headless=new --enable-unsafe-webgpu --use-angle=vulkan --enable-features=Vulkan \
#          --remote-debugging-port=9222 --user-data-dir=/tmp/… http://localhost:5173/src/embed-spike/index.html
#   then CDP Runtime.evaluate: await window.__c7.run({ device: "webgpu", dtype: "fp16", textOnly: true })
```

`?autorun=1&device=webgpu&dtype=fp16&textOnly=1&maxImages=0` runs without a driver and is the exact
configuration that produced §4.3 (fp16 is the only working dtype here; q4/q8 device-lose — §4.2). A
`wasm` run is there on purpose: it is how the "q4 on WASM is broken" claim in §5 was checked on this
machine.

**Weights are never in the repo**: they stream from the HF Hub into the browser's HTTP cache under
the Chrome profile (`--user-data-dir`, e.g. `/tmp/…`). Nothing under `shared/` or `src/` is copied
into this package, and `.gitignore` already covers `node_modules/`/`dist/`.

---

## 4. Measurements

Everything here was produced by `window.__c7.run(...)` / `window.__c7.loadModel(...)` through the CDP
driver described in §3, on the machine in §2. **Nothing in this section is a phone number.**

### 4.1 Cold download and load — measured

| Stage | Cold (browser cache empty) | Warm (same Chrome profile) |
| --- | --- | --- |
| Library import from jsDelivr (`transformers.js` 4.3.1, ESM) | 1,987 ms | 71–101 ms |
| `AutoConfig` | 1,312 ms | 3–12 ms |
| `AutoModel.from_pretrained` (text+vision q4, **283.6 MB** reported by its own progress callback) | **110.8 s** | 1.7 s |
| `AutoModel` text-only q4 (**174.5 MB**) | not run cold (the 283.6 MB run already cached it) | 1.2–1.3 s |
| `AutoModel` text-only q8 (**314.2 MB**) | **71.3 s** | — |
| `AutoModel` text-only fp16 (**542.5 MB**) | **118.5 s** | 1.7 s |
| `AutoModel` text+vision fp16 (**878.1 MB**) | **69.2 s** | 2.1–2.9 s |
| Tokenizer + processor | — | 1.1 s |
| Tokenizer: tokenize the 10 item docs | — | **4–5 ms** |
| `load_image` per fixture JPEG (decode, no network — local Vite URL) | — | 6–85 ms (15 photos) |

The cold q4 download works out to ≈ 2.6 MB/s on this network (q8: ≈ 4.4 MB/s, fp16: 4.6–7.9 MB/s) —
network-dependent, so treat those as "minutes on a normal connection", not a constant. The **warm**
load (~1.7–2.9 s) is what a second visit costs, because transformers.js keeps weights in the browser's
HTTP cache: the `/tmp` Chrome profile grew to ~1.7 GB with all three dtypes and nothing entered git.

### 4.2 Inference on WebGPU: q4 never completes, q8 completes once — **blocked**

This is the important negative result of the spike. Every attempt below is the real model, real
weights, real WebGPU device (adapter `qualcomm/adreno-7xx`), one process at a time:

| # | Mode | dtype | What happened |
| --- | --- | --- | --- |
| 1 | headless | q4 text+vision | first text embed reported 70.95 s, the **next** call never returned (>120 s watchdog) |
| 2 | headless | q4 text-only | first text embed **64.9 s**, then `OrtRun()` error: `mapAsync … [Device] is lost` |
| 3 | headless + `--disable-gpu-watchdog --disable-hang-monitor` | q4 text-only | 60.6 s → same `[Device] is lost` |
| 4 | **headful under Xvfb** (no headless flag) | q4 text-only | 63.3 s → same, `A valid external Instance reference no longer exists` |
| 5 | headless | q8 text-only | first text embed **72.6 s → succeeded, 768-d**; next call 60.8 s → `[Device] is lost`, and every later call fails in ~1 ms |

So on Chrome 154 + Dawn/Vulkan + Adreno 7xx:

- **q4 and q8 cannot sustain inference.** The device is lost ~60–65 s into a call, reproducibly,
  headless and headful. q8 survives exactly **one** embedding per session; q4 never returns a vector.
- The error is always the same `BufferManager::Download` / `wgpu::MapAsyncStatus::DeviceLost` in
  `onnxruntime-web`'s WebGPU EP — i.e. the GPU device, not the model code.
- The harness watchdog (120 s) turns this into a recorded failure instead of a hung page, which is
  why the runs above terminate; without it the page just sits there.

Whether this is a Chrome/Dawn/Vulkan bug on this adapter, a driver TDR/timeout on a long kernel, or
onnxruntime's q4/q8 WebGPU path, cannot be decided from here — and it does **not** generalise to
Android, where Chrome's GPU stack and ORT's WebGPU EP are different builds. What it does mean is that
**the dtype the model card recommends (q4, 284 MB) is not usable on this machine**, and any Android
recommendation that assumes q4 works has to be re-checked on the phone.

### 4.3 fp16 is the dtype that works here — text latency and parity (measured)

Dropping to `dtype: "fp16"` (the same session code, one option changed) is stable: six separate
Chrome launches, zero device-lost errors, numbers repeat across runs. Cost: **542.5 MB** text-only /
**878.1 MB** text+vision instead of 174.5 / 283.6 MB.

| Operation (WebGPU, fp16, batch ≤ 2,700 tokens) | Measured on this laptop (canonical run = `window.__c7.run`, ranges = repeat runs) | Server for comparison (§6) |
| --- | --- | --- |
| Model load, warm (browser cache) | **1.67 s** weights + 1.12 s tokenizer/processor = **2.86 s** to ready (range 1.2–2.9 s) | 2.3 s (weights on disk) |
| Cold first text embed (kernel compile + run) | **196 ms** (other runs: 182 ms, 373 ms) | 295 ms (88–573) |
| Warm single text embed | **45.6 ms median**, p90 47.1, min 44.1 (other runs: 48–98 ms) | 295 ms cache miss / 0.04 ms hit |
| 10 item docs (1 batch of 9 + 1, 154 tokens) | **396 ms total**, batch of 9 = **200 ms → 22 ms/doc** (other run: 331 ms) | 1.9–3.6 s for 44 |
| Text queries, batch of 4 | **94, 96, 98, 99 ms** → ≈ 24 ms/query | 110–155 ms HTTP warm |
| Tokenize 10 docs | **4–5 ms** | n/a (inside the 295 ms) |

Text parity vs `shared/fixtures/golden.json` (fp32 CPU oracle, same inputs, 768-d → first 256 → L2),
from the same run:

| Set | n | min cos | median cos | max abs diff | worst |
| --- | --- | --- | --- | --- | --- |
| item docs | 10 | **0.999938** | 0.999954 | 2.9e-3 | `sha1:2e3fccbb…` |
| text queries | 12 | **0.999936** | 0.999971 | 2.2e-3 | `t08` |
| images | 0 | — | — | — | not measured, §4.4 |

And the end-to-end check that matters: ts-core `rank()` with these browser vectors picks the **golden
expected top-1 for 12/12 text queries**. So fp16-in-the-browser is not merely "close in cosine"; it
preserves the ranking the app actually uses.

So on this GPU the browser beats the server's **warm** text path by ~6× on a single query and by ~3×
per text on a batch (browser 22–39 ms/doc for its 10-doc batch vs the server's 44–83 ms/text for its
44-text batch — the batches are different sizes, so only the per-text rates are comparable, not the
396 ms vs 1.9–3.6 s totals), and it beats the server's **cached** path never — 0.04 ms
is unbeatable. That is the whole argument for keeping cached document vectors server-side and using
the browser only for inputs the server has not seen.

### 4.4 Images on fp16 — the vision encoder does not return (blocked)

The text phase of a full text+vision run is fine; it is the first image call that never comes back:

| Attempt | Setup | Result |
| --- | --- | --- |
| full suite | text+vision fp16, 3 images, `callTimeoutSec=180` | text phase completed (cold embed 182 ms, batch of 9 331 ms, queries 50–58 ms), then `warm single image 1/2` hit the 180 s watchdog → run aborted |
| dedicated image probe | text+vision fp16, **600 s** watchdog, 1 image | decode 39 ms … then nothing for **600,037 ms** ("timed out after 600000 ms") |
| staged probe | `model.ts` now logs preprocessing and the forward pass separately | `image preprocess (1 input(s)) in 35 ms` … then no `image forward pass` line for 150 s |

So the pipeline up to the GPU is healthy: 878.1 MB of weights load in 2.1–2.9 s warm, all 15 fixture
JPEGs decode in 6–85 ms, and the processor builds its inputs in 35 ms. The **vision encoder's forward
pass on WebGPU simply never settles** — no vector, no exception, no device-lost message. It is the
same silent hang seen in the very first q4 run, and it reproduces across five separate Chrome launches
(headless and headful).

Consequences, stated plainly:

- **There is no browser image latency number in this document.** The image path is *unmeasured*, not
  fast and not slow; §1 therefore keeps images on the server.
- **Image parity vs `golden.json` is unmeasured** for the same reason (the harness computes it in
  `parity.images` as soon as a vector exists).
- **The flat-vs-nested image trap is unit-tested but not demonstrated on the GPU** (`harness.test.ts`
  asserts the call shape; the cosine demonstration needs a vector).
- Whether the cause is a shader-compilation blow-up in the vision graph, an ORT WebGPU bug for this
  encoder, or this driver is **not determined here** — deciding it needs either a phone run or a
  `chrome://gpu`/ORT trace session, both out of scope for the card.

### 4.5 What stays unmeasured, and why

- **q4/q8 latency and parity**: no vector was produced for q4, and q8 produced exactly one. Those
  dtypes are blocked on this GPU (§4.2), not skipped.
- **Phone numbers**: none exist anywhere in this document (§2, §8).
- **fp16 on WASM**: not run — the point of the card is the WebGPU path; WASM cannot run q4/q8 at all
  (§5), so a WASM run would only measure the 878 MB fallback that no shipping plan proposes.
- **Live 2.5 fps camera loop**: the per-image number in §4.4 is the input to that decision; the loop
  itself belongs to C4's sampler and was not rebuilt here.


---

## 5. The WebGPU-only claim, checked

The digest's "WASM is broken for q4/q8 — missing `GatherBlockQuantized` kernel" was checked on this
machine, not trusted. Same page, same cached weights, `device: "wasm"`, `dtype: "q4"`, text-only:

```
sessionCreated: false
sessionError: "Can't create a session. ERROR_CODE: 9, ERROR_MESSAGE: Could not find an
implementation for GatherBlockQuantized(1) node with name '/model/embed_tokens/Gather_Quant'"
```

It fails at **session creation**, in ~40 ms after the config loads — there is no slow fallback, so a
browser without WebGPU cannot run q4 or q8 at all.

`fp16` *is* the non-WebGPU escape hatch and it was measured here: it loads (542.5 MB text-only /
878.1 MB text+vision) and runs — on the WebGPU device, because that is the only device that was
proven to work. fp16 on **WASM** was not measured (it would be a multi-hundred-MB shard download and
minutes per embed on 8 laptop cores; the card's question was WebGPU vs server, not WASM vs server).

So the gate is real and hard: a browser without WebGPU has **no** usable EmbeddingGemma 2 path for
q4/q8 — "no model", not "slower model".

---

## 6. Server round-trip, for comparison (from `apps/web/server/PERF.md`, card C3)

Measured on the same laptop, real model, **fp32 CPU** (`google/embeddinggemma-2`, 1.49 GB
safetensors), 8 threads, not the LiteRT/GGUF path:

| Operation | Server (C3, fp32 CPU) | Browser (this spike, WebGPU **fp16**) |
| --- | --- | --- |
| Model load | 2.3 s (weights already on disk) | cold **69–118 s** (543–878 MB download); warm 1.2–2.9 s from the browser cache |
| 1 text, cache miss | 295 ms (88–573) | **182–373 ms** cold-first, then 48–98 ms warm (§4.3) |
| 1 text, cache hit | 0.04 ms | n/a (no cache; re-embedding costs the same as the first time) |
| 44 texts, cache miss | 1.9–3.6 s total (44–83 ms/text) | **≈ 1.0–1.6 s** (10 docs in 331 ms, ≈ 23–37 ms/doc, one batch) |
| 1 product JPEG, cache miss | **6.4–11.9 s** | **no number** — vision encoder forward pass did not return in 600 s (§4.4) |
| HTTP `POST /embed/text` (warm) | 110–155 ms | n/a (no network hop) |
| HTTP `POST /embed/image` | 6.8–8.0 s | n/a |
| Quality vs `golden.json` | min cos 0.999999999996 | text: see §4.3 (fp16, not fp32) |
| Bundle cost | 0 in the browser | 0 in `dist/` (dev-only page), but 543–878 MB cold network for the model |
| Server cost | torch + torchvision, 1.93 GB image, CPU | none |

Two costs that are easy to forget: the server's **GPU-host bill** for the image path (or 6–12 s/frame
on CPU, which is what C3 measured), and the browser's **543–878 MB first run** plus the WebGPU gate,
which a phone on shop Wi-Fi feels once and a phone on mobile data may never pay. The browser's win is
narrow: ~5× the server on an *uncached* single text, and ~3× per text on a batched list — against zero
download and 0.04 ms on the cached path.

---

## 7. Traps, and where each one is pinned

| Trap (source) | Handling | Pinned by |
| --- | --- | --- |
| Batch ≤ ~2,700 tokens on WebGPU (model card "Context Limits") | `MAX_BATCH_TOKENS = 2700`, greedy packing in `planBatches` | `budget.test.ts` |
| ≈280 tokens/image → **9** images per batch (2520 ≤ 2700) | `IMAGE_TOKENS = 280`, `IMAGES_PER_BATCH = 9` | `budget.test.ts` |
| `processor(null, [[a],[b]])` = two inputs; `processor(null, [a,b])` = ONE blended input | `embedImages(groups)` never emits a flat list; `embedImagesFlat` exists only to prove the trap | `harness.test.ts` (asserts every image call group has length 1); the flat-vs-nested cosine could not be measured here (vision forward pass blocked, §4.4) |
| Images take **no** prefix | `imageInput()` returns `prompts.imagePrefix` (`""`); asserted | `budget.test.ts` |
| Prefixes come from `prompts.json`, never hard-coded | `prefixesFromSpec` mirrors `embedder_gemma.load_prefixes` | `budget.test.ts` |
| Text = `prefix + trim(text)`, capped at 2048 chars | `applyPrefix`/`capText` mirror `cap_text`/`apply_prefix` | `budget.test.ts` |
| Matryoshka: re-normalise **after** slicing to 256 | `truncateAndNormalize` truncates first, then L2 (float64) | `vectors.test.ts` (order test: `[1,1,1,1,10]` → `0.5`s, *not* 0.098s) |
| q4/q8 need WebGPU; WASM lacks the kernel; fp16 is 543 MB text / 878 MB text+vision | `device` + `dtype` selects on the page (URL params); each combination recorded in §4–§5 | §4.2 (q4/q8 device lost), §4.3 (fp16 works), §5 (WASM cannot create a q4 session) |

---

## 8. Deviations, gaps and honest limits

1. **No phone.** Every number in §4 is desktop Chrome 154 on the X1E laptop's Adreno 7xx. The card
   asks for phone numbers or a loud disclosure; this is the loud disclosure.
2. **Headless Chrome needed WebGPU flags.** Adapter was `null` until `--enable-unsafe-webgpu
   --use-angle=vulkan --enable-features=Vulkan`. A normal desktop/Android Chrome session has WebGPU
   on by default (Chrome 121+), but headless Linux does not — so "does WebGPU exist in this
   environment" answers *yes with flags*, *no without*.
3. **The WASM failure was verified on this machine** (§5) rather than trusted from the digest.
4. **The dtype is fp16, not the model card's q4.** q4/q8 lose the WebGPU device here (§4.2), so every
   latency and parity number in §4.3–§4.4 is fp16. fp16 is *higher* precision than q4, so parity is
   not the weak spot; the 3× download is.
5. **No image number exists.** The vision encoder's forward pass was given **600 s once** (one
   600,037 ms run; the other two attempts stopped earlier at 180 s and 150 s) and never
   returned (§4.4); preprocessing completes in 35 ms, so the hang is in the GPU forward pass. That is
   reported as a blocked measurement, not as a latency.
6. **The text parity number is fp16-vs-fp32** cosine agreement on the golden inputs, not bit
   equality — the digest's ≈0.988/0.975 figures are q4-vs-fp32 and do not apply to these runs.
7. **The test suite is 26 tests over the pure parts** (budget, vectors, harness with a fake session).
   The model itself is not in CI; CI only keeps `npm test && npm run build && tsc --noEmit` green.
8. **Main bundle unchanged**: `vite build` takes the root `index.html` only and this page is not
   imported from `src/main.tsx`; build output before/after is in the card Notes. No `package.json`
   change was made (transformers.js is a runtime CDN import), so `package-lock.json` is untouched.
