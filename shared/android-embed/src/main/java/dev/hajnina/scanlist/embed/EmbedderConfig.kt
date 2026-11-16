package dev.hajnina.scanlist.embed

import java.io.File

/**
 * Everything the in-process embedder needs (card S5). [modelFile] is the `.litertlm` bundle provisioned
 * by `scripts/model.sh fetch` into the app's own files dir (484,622,336 B, sha256
 * `e7a8a220…f4c` for the CPU/GPU bundle; RECIPE.md §3). The library never downloads it: weights are not
 * in git and provisioning is card S6's job.
 */
data class EmbedderConfig(
    /** The `.litertlm` bundle. Required: there is no default path — the app owns its files dir. */
    val modelFile: File,

    /** Stored with cached vectors; vectors may only be compared within one model id. */
    val modelId: String = DEFAULT_MODEL_ID,

    /**
     * sha256 of [modelFile], used to reject a golden-vector asset made for another bundle (RECIPE.md §7.9).
     * Null disables the check (the self-test then refuses GPU/NPU, because they cannot be proven).
     */
    val modelSha256: String? = DEFAULT_MODEL_SHA256,

    /** Native output size of the model. EmbeddingGemma 2 is 768. */
    val nativeDims: Int = 768,

    /**
     * Matryoshka size returned by the embedder. Null (default) means "whatever `prompts.json` says
     * (`dims.active`, 256 today)": the number lives in the shared spec, not in code.
     */
    val matryoshkaDims: Int? = null,

    /**
     * LiteRT input length the engine is opened with (one of the model's powers of two 128..8192,
     * lowered to the context the bundle reports). Buffers and GPU memory scale with it; 2048 is
     * MnemoThera's text-pipeline size (RECIPE.md §3).
     */
    val maxInputLength: Int = 2048,

    /**
     * Vision tokens per image. The on-device LiteRT bundle is provisioned for 70 or 140 (the HF/ONNX
     * default ~280 is more expensive; docs/ARCHITECTURE.md), so 70 is the cheap default.
     */
    val visionTokensPerImage: Int = 70,

    /**
     * Try the Qualcomm NPU first. **Off by default**: the EmbeddingGemma NPU path is experimental
     * (RECIPE.md §7: the SM8750 bundle fails on LiteRT-LM 0.18.1/0.19.1, the uncompiled one JIT-compiles
     * for 140-236 s on every open). Card B0 is the device probe that can justify turning this on.
     */
    val allowNpu: Boolean = false,

    /** Override the candidate order (tests, a settings screen). Null = NPU (only if allowed), GPU, CPU. */
    val backendOrder: List<EmbedBackend>? = null,

    /** Ask LiteRT-LM for FLOAT32 activations. The EmbeddingGemma model card says never float16 (RECIPE.md §7.2); default = runtime default. */
    val useFloat32Activations: Boolean = false,
) {
    init {
        require(nativeDims > 0) { "nativeDims must be positive" }
        require(maxInputLength > 0) { "maxInputLength must be positive" }
        require(visionTokensPerImage > 0) { "visionTokensPerImage must be positive" }
    }

    /** The ladder order: opt-in NPU first, then GPU, then the CPU fallback. */
    fun candidates(): List<EmbedBackend> = backendOrder ?: buildList {
        if (allowNpu) add(EmbedBackend.NPU)
        add(EmbedBackend.GPU)
        add(EmbedBackend.CPU)
    }

    companion object {
        /** The bundle the project ships (litert-community/embeddinggemma-2-740m-litert-lm, CPU + GPU). */
        const val DEFAULT_MODEL_ID = "embeddinggemma-2-740m"

        /** sha256 of `embeddinggemma-2-740m.litertlm` (RECIPE.md §3; scripts/model.sh pins the same value). */
        const val DEFAULT_MODEL_SHA256 = "e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c"
    }
}
