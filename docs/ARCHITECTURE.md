# ScanList — architecture

A shopping list app. Lists are nested JSON (section → sub-section… → item + amount, see `docs/list.schema.json`).
The magic: a **"magic barcode reader"** — point the phone at a product, the app embeds what the camera sees and
**re-sorts the open list items by vector similarity**, so the matching item jumps to the top and is ticked with one tap.

Three implementations are built **in parallel** to compare them: **A) React Native**, **B) Kotlin (Jetpack Compose)**,
**C) Web app + small backend server**. They share one spec, one ranking algorithm, one set of golden test fixtures.

## Shared pipeline (identical in all three tracks)

```
 list.json ──parse──► flatten(path, item) ──► item text ──► embed(doc) ──► item vectors (cached by sha1(text+model))
                                                                                      │
 camera frame ──► Scan sources (parallel, pluggable):                                  │
   1. barcode   (ML Kit / zxing / BarcodeDetector) ──► Open Food Facts name lookup ─┐  │
   2. text OCR  (ML Kit text / Tesseract.js)       ──► visible words ─────────────┤  │
   3. image embed — EmbeddingGemma 2 embeds the frame directly (shared space) ─────┤  │
                                                                                   ▼  ▼
                                                     query vector(s) ──► cosine ──► score per item
                                                                                         │
                                         EMA smoothing (α=0.5) + hysteresis ──► sorted unchecked items, top one highlighted
```

- **Model**: **EmbeddingGemma 2 (740M)**: text + image (+audio) in ONE 768-dim space, Matryoshka 512/256/128.
  On-device bundle `litert-community/embeddinggemma-2-740m-litert-lm` (`embeddinggemma-2-740m.litertlm`, 484,622,336 B).
  Images take no prefix (~280 tokens each). See `references/embeddinggemma/RECIPE.md`.
- **Item document text**: `{DOC_PREFIX}{name}; {aliases joined by ', '}; {section path joined by ' > '}`
- **Query text** (barcode name / OCR words): `{QUERY_PREFIX}{text}`. Image queries: raw image, no prefix.
- **Prefixes are UNDECIDED**: MnemoThera uses `task: search result | text: ` / `task: search query | text: `, the model
  card says `title: none | text: ` / `task: search result | query: `. Card S3 picks the winner on the golden set;
  until then they live in `shared/spec/prompts.json`, never hard-coded.
- **Dims**: Matryoshka-truncate to **256**, L2-normalise, cosine = dot product.
- **Score fusion**: score = max(image_cos, text_cos), with barcode exact name match boosting +0.15.
- **Ranking**: unchecked items sorted by score desc; checked items sink to a collapsed "Done" group; ties keep JSON order.
  Re-rank at most every 400 ms; the top item only changes when its smoothed score beats the current top by > 0.02 (no jitter).
- **Fallback when no scan signal**: original JSON order (sections intact). Ranked mode shows a flat list with a section chip.
- **State**: done flags + list persisted locally; export back to the same JSON shape (`done: true`).

## Embedding backends

MnemoThera (Therapy_local) runs EmbeddingGemma 2 with **LiteRT-LM `EmbeddingEngine`** (`litertlm-android:0.18.1`):
ladder **NPU → GPU → CPU**, separate process, self-test vs CPU golden vectors (cos ≥ 0.98), 2 strikes blocks a backend.
Measured text embed: POCO F8 Pro GPU ~35 ms / CPU ~72 ms; Pixel 8 GPU ~110 ms / CPU ~250 ms.
**NPU is experimental** (SM8750 bundle fails on 0.18.1/0.19.1; JIT compile 140–236 s on load) → ship GPU + CPU, NPU behind a flag.
**Image embedding is unverified on device**: first card (B0) probes `inputModalities()` and embeds one JPEG on GPU and CPU.
If images disappoint: SigLIP 2 LiteRT (`litert-community/SigLIP2-base-patch16-224`) as a separate image↔text model.

| Track | Embedding | Notes |
|---|---|---|
| B Kotlin | Port of MnemoThera's engine (`references/embeddinggemma/`): NPU first, GPU second, CPU fallback, auto-select + fallback chain | source of truth for on-device numbers |
| A React Native | Native module wrapping **the same Kotlin engine** (shared Gradle module `shared/android-embed`) | compares the UI/runtime layer, not the model |
| C Web | Backend server embeds text AND images (EmbeddingGemma 2 via `transformers`/`sentence-transformers` or GGUF via llama.cpp — card C3 verifies which supports images), browser does camera + barcode + OCR | runs on laptop/Oracle, phone opens the page |

Common interface (all languages):
```
interface Embedder { name; backend /* npu|gpu|cpu|server|wasm */; dims; embedDocs(texts[]): float[][]; embedQuery(text): float[] }
interface ScanSource { name; start(onSignal(text, confidence)); stop() }
rank(items, queryVecs, prevScores) -> [{itemId, score}]   // pure function, golden-tested
```

## Repo layout

```
shared/        spec, fixtures (golden queries → expected top-3), reference ranker (Python), Open Food Facts client notes
shared/android-embed/   Kotlin library module: Embedder impls (NPU/GPU/CPU) — used by B and A
apps/kotlin/   Track B  (Compose, M3 Expressive per references/bonsai-ui/STYLE_GUIDE.md)
apps/rn/       Track A  (React Native, bare/Expo prebuild, Material 3 look via react-native-paper or custom)
apps/web/      Track C  (frontend + server/)
bench/         comparison harness + COMPARISON.md
kanban/        the board (see kanban/README.md)
references/    copied source from MnemoThera (Therapy_local) and Bonsai Serve — read-only reference
```

## UI (all tracks, M3 Expressive)
1. **Lists**: import JSON (file picker / paste / URL), list of lists.
2. **List**: nested sections, tick items, amounts, progress bar (14dp round caps).
3. **Scan** (the magic): camera preview top ~45 %, ranked list below; top match is a big hero card with a large tick button;
   haptic on tick; sources shown as chips (barcode / text / image) lighting up when they fire.
4. **Settings**: embedding backend picker (auto/NPU/GPU/CPU/server) with live latency, model status.
