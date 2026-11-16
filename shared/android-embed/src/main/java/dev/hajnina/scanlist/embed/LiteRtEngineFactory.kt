package dev.hajnina.scanlist.embed

import android.content.Context
import com.google.ai.edge.litertlm.ActivationDataType
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.EmbeddingEngine
import com.google.ai.edge.litertlm.EmbeddingEngineConfig
import com.google.ai.edge.litertlm.EmbeddingOptions
import com.google.ai.edge.litertlm.InputData
import com.google.ai.edge.litertlm.ModelInfo
import com.google.ai.edge.litertlm.Modality
import java.io.File

/**
 * The real [EngineFactory]: LiteRT-LM `EmbeddingEngine` on top of the `.litertlm` bundle (card S5).
 *
 * Adapted from references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/engine/runner/EmbedRunner.kt
 * (`open`, `runText`, `logModelInfo`, `isolatedCacheDir`) and the Google AI Edge Gallery embedder it
 * credits (Apache-2.0), with these parts copied deliberately:
 *
 *  * capabilities are read from the bundle with `ModelInfo.from(path)`, not assumed
 *    (`inputModalities().vision/audio`, `maxContextTokens()`, `supportedBackends(Modality.TEXT)`);
 *  * the audio encoder is disabled (`audioBackend = null`): ScanList never embeds audio and the audio
 *    encoder is ~300M extra parameters (RECIPE.md §3);
 *  * the vision encoder, when the bundle has one, runs on the same backend as text (GPU/CPU). The NPU
 *    never gets vision: that path is experimental (RECIPE.md §7), so images fall back to the strike /
 *    next backend rule like any other failure;
 *  * one cache dir per input length (`emb_t<N>`): reusing one across sizes is wrong (RECIPE.md §7.7);
 *  * `EmbeddingOptions(normalize = true, insertSpecialTokens = true, outputSize = …)` — the engine
 *    returns unit vectors, and [LiteRtEmbedder] re-normalises defensively after truncation.
 *
 * LiteRT-LM version: **0.18.1**, the version MnemoThera measured on three phones. It already has the
 * vision API (`EmbeddingEngineConfig.visionBackend`, `visionTokensPerImage`, `InputData.Image`), so the
 * researched 0.19.1 was not needed (verified with javap on both AARs: identical shape).
 */
class LiteRtEngineFactory(
    private val context: Context,
    private val modelFile: File,
    private val maxInputLength: Int = 2048,
    private val visionTokensPerImage: Int = 70,
    private val useFloat32Activations: Boolean = false,
) : EngineFactory {

    override fun open(backend: EmbedBackend): EmbedEngine {
        check(modelFile.isFile) {
            "model bundle not found: ${modelFile.path} (provision it with scripts/model.sh fetch/push, card S6)"
        }
        val info = readModelInfo(modelFile)
        val litertBackend = litertBackend(context, backend)
        val visionBackend = if (info.vision && backend != EmbedBackend.NPU) litertBackend else null
        val cacheDir = File(context.cacheDir, "emb_t$maxInputLength").apply { mkdirs() }
        val engine = EmbeddingEngine(
            EmbeddingEngineConfig(
                modelPath = modelFile.path,
                backend = litertBackend,
                visionBackend = visionBackend,
                audioBackend = null,
                cacheDir = cacheDir.path,
                maxInputLength = maxInputLength,
                visionTokensPerImage = visionTokensPerImage,
                activationDataType = if (useFloat32Activations) ActivationDataType.FLOAT32 else null,
            ),
        )
        try {
            // Blocking: 1-8 s on GPU, 1-2 s on CPU, minutes on the NPU. Never call from the main thread.
            engine.initialize()
        } catch (t: Throwable) {
            runCatching { engine.close() }
            throw t
        }
        return LiteRtEmbeddingEngine(engine, info, visionTokensPerImage)
    }

    /** What the bundle itself declares. Audio is not a requirement for ScanList. */
    private fun readModelInfo(file: File): EngineModelInfo =
        ModelInfo.from(file.path).use { info ->
            val modalities = info.inputModalities()
            EngineModelInfo(
                maxContextTokens = info.maxContextTokens(),
                text = modalities.text,
                vision = modalities.vision,
                audio = modalities.audio,
                textBackends = runCatching { info.supportedBackends(Modality.TEXT).map { it.name } }.getOrDefault(emptyList()),
            )
        }

    companion object {
        /**
         * The LiteRT-LM backend for [backend]. Ported from
         * references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/models/LiteRtBindings.kt (MnemoThera);
         * the NPU needs the Qualcomm dispatch libraries in the native library dir.
         */
        fun litertBackend(context: Context, backend: EmbedBackend): Backend = when (backend) {
            EmbedBackend.NPU -> Backend.NPU(nativeLibraryDir = context.applicationInfo.nativeLibraryDir)
            EmbedBackend.GPU -> Backend.GPU()
            EmbedBackend.CPU -> Backend.CPU()
        }
    }
}

/** One open LiteRT-LM `EmbeddingEngine`, adapted to the [EmbedEngine] seam. */
internal class LiteRtEmbeddingEngine(
    private val engine: EmbeddingEngine,
    override val modelInfo: EngineModelInfo,
    private val visionTokensPerImage: Int,
) : EmbedEngine {

    override fun embedText(prefixed: String, outputSize: Int): FloatArray =
        engine.computeEmbedding(
            listOf(InputData.Text(prefixed)),
            EmbeddingOptions(normalize = true, insertSpecialTokens = true, outputSize = outputSize),
        ).embedding

    override fun embedImage(jpeg: ByteArray, outputSize: Int, visionTokensPerImage: Int): FloatArray {
        if (!modelInfo.vision) {
            throw EmbeddingUnavailableException(
                "the loaded bundle has no vision encoder (ModelInfo.inputModalities().vision == false); " +
                    "text embedding still works — use the barcode/OCR scan sources, or probe another bundle (card B0)",
            )
        }
        if (jpeg.isEmpty()) throw IllegalArgumentException("empty JPEG")
        return engine.computeEmbedding(
            listOf(InputData.Image(jpeg)),
            EmbeddingOptions(
                normalize = true,
                insertSpecialTokens = true,
                outputSize = outputSize,
                visionTokensPerImage = visionTokensPerImage.takeIf { it > 0 } ?: this.visionTokensPerImage,
            ),
        ).embedding
    }

    override fun close() {
        engine.close()
    }
}
