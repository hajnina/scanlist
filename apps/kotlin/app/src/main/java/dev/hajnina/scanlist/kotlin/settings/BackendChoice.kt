package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.EmbedBackend
import dev.hajnina.scanlist.embed.EmbedderConfig
import java.io.File

/**
 * The four options of the settings backend picker (docs/ARCHITECTURE.md §UI 4), mapped honestly onto
 * shared/android-embed's [EmbedBackend] ladder (card S5):
 *
 *  * [AUTO] — the shipped default: GPU first, CPU fallback. This is exactly
 *    [EmbedderConfig.candidates]'s own order (`allowNpu = false`), so the picker does not invent a
 *    second policy.
 *  * [GPU] — strict. The settings screen is a probe, so asking for the GPU reports a GPU failure
 *    instead of silently measuring the CPU and labelling it "GPU".
 *  * [CPU] — strict CPU, the golden reference backend.
 *  * [NPU] — strict **and experimental**: RECIPE.md §7 (the SM8750 bundle fails on LiteRT-LM
 *    0.18.1/0.19.1; an uncompiled bundle JIT-compiles for 140-236 s on open). The UI marks it and
 *    AUTO never contains it.
 *
 * Ids are the lowercase strings of the cross-track spec ("auto|gpu|cpu|npu"), so the persisted
 * preference and the embedder's own `backend` value read the same in all three builds.
 */
enum class BackendChoice(val id: String, val label: String, val experimental: Boolean) {
    AUTO("auto", "Auto", false),
    GPU("gpu", "GPU", false),
    CPU("cpu", "CPU", false),
    NPU("npu", "NPU", true);

    /** The exact ladder this choice asks [dev.hajnina.scanlist.embed.BackendLadder] to try, in order. */
    fun candidates(): List<EmbedBackend> = when (this) {
        AUTO -> listOf(EmbedBackend.GPU, EmbedBackend.CPU)
        GPU -> listOf(EmbedBackend.GPU)
        CPU -> listOf(EmbedBackend.CPU)
        NPU -> listOf(EmbedBackend.NPU)
    }

    /** What selecting this option will attempt, for the picker's one-line explanation. */
    fun ladderLabel(): String = when (this) {
        AUTO -> "GPU → CPU fallback"
        GPU -> "GPU only"
        CPU -> "CPU only"
        NPU -> "NPU only · experimental"
    }

    /**
     * The embedder config a settings self-test runs this choice with. [backendOrder] is explicit (it
     * wins over [EmbedderConfig.allowNpu] in [EmbedderConfig.candidates]); [allowNpu] is still set so
     * the data class reads honestly if a later caller drops the explicit order.
     */
    fun config(
        modelFile: File,
        modelId: String = EmbedderConfig.DEFAULT_MODEL_ID,
    ): EmbedderConfig = EmbedderConfig(
        modelFile = modelFile,
        modelId = modelId,
        allowNpu = this == NPU,
        backendOrder = candidates(),
    )

    companion object {
        /** Never chosen = the shipped GPU→CPU ladder. */
        val DEFAULT = AUTO

        /** Never throws: an unknown or absent persisted id falls back to [DEFAULT]. */
        fun fromId(id: String?): BackendChoice =
            entries.firstOrNull { it.id == id?.trim()?.lowercase() } ?: DEFAULT
    }
}
