package dev.hajnina.scanlist.embed

import java.io.Closeable

/**
 * The one embedding seam of ScanList: text documents, a query and a camera frame, all in one vector
 * space (EmbeddingGemma 2, 768-d native, Matryoshka-truncated to [dims]). Card S5.
 *
 * The interface is the cross-track contract from docs/ARCHITECTURE.md ("Embedder { name; backend;
 * dims; embedDocs(texts[]); embedQuery(text) }") plus the image entry point the magic scan needs. The
 * vectors this returns are **already truncated to [dims] and L2-normalised**, so cosine similarity is
 * a plain dot product: `Vectors.dot(a, b)`.
 *
 * Implementations are blocking and serialise internally (the LiteRT-LM engine is not thread-safe).
 * Call them from a background thread: the first call loads the model (GPU 3-8 s, CPU 1-2 s on the
 * phones in references/embeddinggemma/RECIPE.md §6) and every call is a native inference.
 */
interface Embedder : Closeable {

    /**
     * Backend the embedder ended up on: [BACKEND_GPU], [BACKEND_CPU], [BACKEND_NPU], or
     * [BACKEND_NONE] before the first use / after [close]. Read it after the first [embedQuery] (or
     * after an explicit open) for the value the fallback ladder settled on.
     */
    val backend: String

    /** Length of every vector this embedder returns (Matryoshka dims, 256 for ScanList). */
    val dims: Int

    /**
     * Whether the loaded model bundle declares a vision encoder, so [embedImage] can work. False
     * before the model is open; on a text-only bundle it stays false forever. (LiteRT-LM has no
     * "list capabilities" call — this comes from `ModelInfo.inputModalities().vision`, RECIPE.md §1.)
     */
    val supportsImages: Boolean

    /** The model identity these vectors belong to; cached vectors must be compared only within it. */
    val modelId: String

    /** Embeds shopping-list items (documents). Each text gets the doc prefix from `prompts.json`. */
    fun embedDocs(texts: List<String>): List<FloatArray>

    /** Embeds a scan query (barcode name / OCR words) with the query prefix from `prompts.json`. */
    fun embedQuery(text: String): FloatArray

    /** Embeds a JPEG camera frame. Images take **no** prefix (model card + prompts.json). */
    fun embedImage(jpeg: ByteArray): FloatArray

    companion object {
        const val BACKEND_NONE = "none"
        const val BACKEND_NPU = "npu"
        const val BACKEND_GPU = "gpu"
        const val BACKEND_CPU = "cpu"

        /** Matryoshka size from `shared/spec/prompts.json` (`dims.active`), used when no prompts file is available. */
        const val DEFAULT_DIMS = 256
    }
}

/** A failure of the embedder itself (bad vectors, no model, no usable backend). */
open class EmbedderException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Every candidate backend failed or was skipped. [reasons] has one line per candidate, in the order
 * they were tried ("gpu: IllegalArgumentException: …"), [candidates] are their ids.
 */
class NoBackendException(val candidates: List<String>, val reasons: List<String>) :
    EmbedderException("No embedding backend could load (${candidates.joinToString(",")}): " + reasons.joinToString("; "))

/** The embedder cannot serve this call at all: images on a text-only bundle, or a closed embedder. */
class EmbeddingUnavailableException(message: String, cause: Throwable? = null) : EmbedderException(message, cause)
