package dev.hajnina.scanlist.kotlin.rank

import dev.hajnina.scanlist.embed.Embedder

// The embedding seam of the rank package (card B3). Production wraps S5's `Embedder`; JVM tests plug
// a fake that returns the vectors of `shared/fixtures/golden.json`, so the whole ranking path — cache,
// index, rank — is exercisable without a model or a device.

/**
 * Exactly what the ranker needs from an embedder, in **float64**.
 *
 * RANK.md §2 requires float64 arithmetic: model output is float32 and widening is exact, so the
 * vectors that cross this seam are already widened. Implementations must return 256-d (or
 * [dims]) vectors that are **truncated and L2-normalised** (that is what [Embedder] returns), and
 * must apply the doc prefix themselves — this seam speaks `docText` (FLATTEN.md §4), not prompt
 * strings. The cache key hashes the prefix separately (RANK.md §2.1), so a source whose prefix
 * differs from the cache's must use a different [ItemVectorCache].
 */
interface VectorSource {
    /** The model identity these vectors belong to; cached vectors are only valid within it. */
    val modelId: String

    /** Vector length (Matryoshka dims, 256 for ScanList). */
    val dims: Int

    /** Embed item documents (docTexts, no prefix); the source adds the doc prefix. */
    fun embedDocs(docTexts: List<String>): List<DoubleArray>

    /** Embed a scan query (barcode name / OCR words); the source adds the query prefix. */
    fun embedQuery(text: String): DoubleArray

    /** Embed a JPEG camera frame; images take no prefix. */
    fun embedImage(jpeg: ByteArray): DoubleArray
}

/**
 * [VectorSource] over the shared `shared/android-embed` embedder (card S5). The only adapter in the
 * rank package that knows the embed library exists; the widening to float64 is exact (RANK.md §2).
 */
class EmbedderVectorSource(private val embedder: Embedder) : VectorSource {

    override val modelId: String get() = embedder.modelId

    override val dims: Int get() = embedder.dims

    override fun embedDocs(docTexts: List<String>): List<DoubleArray> =
        embedder.embedDocs(docTexts).map { it.toFloat64() }

    override fun embedQuery(text: String): DoubleArray = embedder.embedQuery(text).toFloat64()

    override fun embedImage(jpeg: ByteArray): DoubleArray = embedder.embedImage(jpeg).toFloat64()
}

/** float32 model output → float64, exactly (RANK.md §2: widen before truncating/normalising). */
fun FloatArray.toFloat64(): DoubleArray = DoubleArray(size) { this[it].toDouble() }
