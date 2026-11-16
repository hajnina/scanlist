# `modules/embed` — native TurboModule: EmbeddingGemma 2 (placeholder)

Card A1 reserves this directory; **no native code yet** (a later card implements it).

Planned shape (docs/ARCHITECTURE.md, "Common interface"):

```
interface Embedder { name; backend /* npu|gpu|cpu|server|wasm */; dims; embedDocs(texts[]): float[][]; embedQuery(text): float[] }
```

Track A does not embed in JavaScript: it wraps the **same Kotlin engine** the Kotlin track uses
(`shared/android-embed`), so both tracks compare UI/runtime layers on identical model code.
That means a React Native *Codegen* TurboModule here, spec'd in `NativeEmbed.ts`, implemented in
Kotlin by delegating to `shared/android-embed`, and autolinked into `apps/rn/android`.

Nothing in `apps/rn` references this module yet — adding it now would add an unused native
dependency to the skeleton build.
