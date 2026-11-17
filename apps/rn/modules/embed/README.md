# `modules/embed` — the EmbeddingGemma 2 seam for Track A (card A3)

Track A does not embed in JavaScript. This module is the typed Promise API over the **same Kotlin
engine** Track B uses — `shared/android-embed` (card S5) — reached through the `Embed` native module in
`apps/rn/android/app/src/main/java/dev/hajnina/scanlist/rn/embed/`. Both tracks therefore compare UI and
runtime layers on identical model code (`docs/ARCHITECTURE.md`, "Embedding backends").

```
JS: modules/embed/index.ts  ──  bridge  ──►  EmbedModule.kt  ──►  shared/android-embed (LiteRT-LM)
      embedder (contract)                     (worker thread)       GPU → CPU ladder + self-test
      base64ToFloat32                         base64 float32 ←──
```

## What it exposes

```ts
import {embedder, embedDocs, embedStatus} from '../../modules/embed';

const {vectors, backend, dims, latencyMs, openMs} = await embedDocs(['milk', 'Oat Milk 3.5%']);
```

| export | meaning |
|---|---|
| `embedder` / `getEmbedder()` | the cross-track contract: `name`, `backend`, `dims`, `embedDocs`, `embedQuery`, `embedImage` |
| `embedDocs(texts)` | detailed batch call: `vectors`, `backend`, `dims`, `latencyMs`, `openMs` |
| `embedQuery(text)` | one vector + metadata (query prefix) |
| `embedImage({base64} \| {uri})` | one image vector, no prefix (needs a vision-capable bundle) |
| `embedStatus()` | `linked`, `backend`, `dims`, `modelId`, `modelPresent`, `modelPath`, `modelBytes`, `modelReadable`, `modelSha256`, `prompts`, `open`, `hint` — never rejects |
| `closeEmbed()` | unload the model; the next call reopens it through the ladder |
| `setBackend(choice)` | card A6: persist `auto \| gpu \| cpu \| npu`, unload the open engine (strict choices fail honestly instead of mislabelling a fallback) |
| `deleteTempFile(path)` | card A6: delete one scanner temp JPEG; the native side refuses paths outside the app cache and an older binary resolves `{deleted:false}` instead of throwing |
| `BACKEND_CHOICES` | the picker ids the bridge accepts (`auto`, `gpu`, `cpu`, `npu`) |
| `EmbedError` + `EMBED_ERROR` | stable `code`s: `E_MODEL_MISSING`, `E_NO_BACKEND`, `E_UNAVAILABLE`, `E_INPUT`, `E_IMAGE`, `E_EMBED`, `E_NO_MODULE`, `E_CODEC` |
| `base64ToFloat32` | the vector codec (exported for tests and future `Float32Array` consumers) |

`embedder.backend` / `embedder.dims` are synchronous: the last successful call's values, or the
module constants (`none` / `dims.active` = 256) before the first one.

## How it is wired

* Native: `EmbedModule.kt` is a plain `ReactContextBaseJavaModule` (not a codegen TurboModule),
  registered by `EmbedPackage.kt` in `MainApplication.getPackages`. RN 0.88 runs it through the
  legacy-module interop layer under the new architecture, so JS sees one TurboModule named `Embed`.
  Codegen was skipped on purpose: a codegen spec needs `codegenConfig` in a package-level
  `package.json` / autolinked RN library, i.e. files outside this card's `owns`, and five methods
  gain nothing from a generated spec.
* Gradle: `apps/rn/android/settings.gradle` only includes `shared/android-embed` by path
  (`../../../shared/android-embed`). The dependency, `minSdk` and the Kotlin compiler flag now live
  where they belong (card A6 nit a): `android/build.gradle` sets `minSdkVersion = 31` (LiteRT-LM
  0.18.1 needs Android 12; the RN skeleton pinned 24) and `app/build.gradle` adds
  `implementation project(':android-embed')` plus
  `-Xskip-metadata-version-check` (LiteRT-LM's Kotlin 2.4 metadata vs RN 0.88's Kotlin 2.2 — the same
  flag `shared/android-embed` already uses). The old `gradle.beforeProject` hook that injected all
  three from `settings.gradle` is gone.
* Model file: the library never downloads weights. `EmbedModel.kt` looks in
  `<files>/models/embeddinggemma-2-740m.litertlm` (internal first, then external), and in
  `<files>/models/embeddinggemma-2-740m/embeddinggemma-2-740m.litertlm`
  (`LiteRtEmbedder.defaultModelFile`). A missing file is `E_MODEL_MISSING` with the exact
  `scripts/model.sh push <package>` hint — the expected state until card B0/S6 provisions a phone.
  `status()` reports the chosen path, byte size and readability so the settings model card can say
  `E_NO_MODEL`/unreadable without guessing (the sha is a pinned EXPECTED label, not recomputed).
* Threading: all calls are serialised on one worker thread; the JS thread never blocks. The first
  call also loads and self-tests the model (CPU 1–2 s, GPU 3–8 s), reported as `openMs`. A failed
  `open()` resets the cached `created` flag, so the next call retries instead of pretending the
  engine exists.

## Settings screen (card A6)

`apps/rn/src/settings/` is the RN twin of the Kotlin track's B6 settings: `setBackend` persists the
picker choice and unloads the engine, `embedStatus()` feeds the model card (`modelBytes`,
`modelReadable`, `modelSha256`, `prompts`), and the self-test (`latency.ts`) opens the engine on the
chosen ladder, measures one warm-up + three fixed documents, and closes it again. The prefix card
reads `prompts` from `status()` — exactly what the engine loaded from `shared/spec/prompts.json` —
instead of hard-coding prefix strings. See `src/settings/__tests__/` for the decisions (no device
needed) and `docs/POLISH.md` for the states.

## Test screen

`src/dev/` — `DevEntry` adds **"Embed self-test (A3)"** to RN's dev menu (shake / Ctrl+M / ⌘M in a
debug build) and renders `EmbedSelfTestScreen` in a modal: backend, dims, latency, model-open time,
the first six components of the first vector, engine facts, and the `E_MODEL_MISSING` hint card.
`src/App.tsx` renders `<DevEntry />` (one line; that is the only edit outside this directory).

## Tests

```bash
cd apps/rn && npm run typecheck && npm test && npx eslint .
```

* `__tests__/embed.test.ts` — codec (little-endian, padding, bad characters, non-float32 length),
  resolve shapes, `EmbedError.code` propagation, `E_NO_MODULE` without the module, image input
  routing (`base64` vs `uri`), status when unlinked, contract getters.
* `src/dev/__tests__/EmbedSelfTestScreen.test.tsx` — the screen prints backend/dims/latency/components,
  and renders the missing-model state gracefully.

No Kotlin unit test: `app/src/test` and the app module's `testImplementation` are outside the card's
`owns`; the Kotlin glue is six lines of `java.util.Base64` over a little-endian `ByteBuffer`
(`EmbedVectors.kt`) and is compiled by `assembleDebug` (CI). The decoding direction is tested here.
