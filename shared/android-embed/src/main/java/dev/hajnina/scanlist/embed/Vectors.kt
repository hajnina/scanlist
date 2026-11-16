package dev.hajnina.scanlist.embed

import kotlin.math.sqrt

/**
 * Vector maths for EmbeddingGemma 2 output (card S5): Matryoshka truncation, L2 normalisation and
 * cosine. Kept as pure functions on FloatArray so the JVM tests can prove the maths without a model.
 *
 * [cosine] is copied from
 * references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/embed/EmbedGolden.kt
 * (`EmbedGolden.cosine`, MnemoThera): same -1 sentinel for a size mismatch or a zero vector, so the
 * golden-vector comparison behaves exactly like the reference implementation.
 *
 * Matryoshka: the model is trained so the first N dimensions of the native 768-d vector are a valid
 * embedding on their own (768/512/256/128). Truncate **then** renormalise, or cosine drifts (RECIPE.md §5).
 */
object Vectors {

    /** Dot product; cosine similarity for two already normalised vectors. */
    fun dot(a: FloatArray, b: FloatArray): Float {
        require(a.size == b.size) { "dot: ${a.size} dims vs ${b.size} dims" }
        var s = 0f
        for (i in a.indices) s += a[i] * b[i]
        return s
    }

    /** L2 norm, accumulated in Double so a 768-d vector does not lose precision. */
    fun norm(v: FloatArray): Float {
        var sum = 0.0
        for (x in v) sum += x.toDouble() * x.toDouble()
        return sqrt(sum).toFloat()
    }

    /** L2-normalises a copy of [v]; an all-zero vector cannot be normalised and comes back as zeros. */
    fun normalize(v: FloatArray): FloatArray {
        val n = norm(v)
        if (n == 0f || !n.isFinite()) return v.copyOf()
        return FloatArray(v.size) { v[it] / n }
    }

    /** Cosine similarity, or -1 when the vectors cannot be compared (size mismatch, zero vector): the reference's rule. */
    fun cosine(a: FloatArray, b: FloatArray): Float {
        if (a.size != b.size || a.isEmpty()) return -1f
        var ab = 0.0
        var aa = 0.0
        var bb = 0.0
        for (i in a.indices) {
            ab += a[i] * b[i]
            aa += a[i] * a[i]
            bb += b[i] * b[i]
        }
        return if (aa == 0.0 || bb == 0.0) -1f else (ab / (sqrt(aa) * sqrt(bb))).toFloat()
    }

    /** The first [dims] components of [v] (Matryoshka truncation), not normalised. */
    fun truncate(v: FloatArray, dims: Int): FloatArray {
        require(dims > 0) { "Matryoshka dims must be positive, was $dims" }
        require(dims <= v.size) { "cannot Matryoshka-truncate a ${v.size}-dim vector to $dims dims" }
        return v.copyOf(dims)
    }

    /** Matryoshka truncation followed by L2 normalisation — what an [Embedder] returns. */
    fun truncateAndNormalize(v: FloatArray, dims: Int): FloatArray = normalize(truncate(v, dims))
}
