package dev.hajnina.scanlist.embed

import java.io.Closeable

/**
 * The native engine seam (card S5): everything the embedder needs from LiteRT-LM, with no Android or
 * LiteRT-LM type in the signature, so the fallback ladder and the self-test run on the JVM against a
 * fake engine ([EngineFactory] is the only thing a test has to implement).
 *
 * One instance is one open engine on one backend. Not thread-safe: [LiteRtEmbedder] serialises calls.
 */
interface EmbedEngine : Closeable {
    /** Embeds an already-prefixed text at [outputSize] dims (768 for the self-test; the runtime normalises). */
    fun embedText(prefixed: String, outputSize: Int): FloatArray

    /** Embeds JPEG bytes at [outputSize] dims. Throws [EmbeddingUnavailableException] when the bundle has no vision encoder. */
    fun embedImage(jpeg: ByteArray, outputSize: Int, visionTokensPerImage: Int): FloatArray

    /** What the bundle says about itself; read once at open (`ModelInfo` in the real engine). */
    val modelInfo: EngineModelInfo
}

/** Capabilities and limits reported by the model bundle (`ModelInfo` in LiteRT-LM; RECIPE.md §1). */
data class EngineModelInfo(
    val maxContextTokens: Int,
    val text: Boolean = true,
    val vision: Boolean = false,
    val audio: Boolean = false,
    /** LiteRT-LM backend enum names the bundle supports for text, for logs ("CPU/GPU/NPU"). */
    val textBackends: List<String> = emptyList(),
) {
    init {
        require(text) { "an embedding engine without a text encoder cannot serve ScanList" }
    }
}

/** Creates and initialises one engine on one backend. Throws when the backend cannot load. */
fun interface EngineFactory {
    fun open(backend: EmbedBackend): EmbedEngine
}
