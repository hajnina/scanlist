package dev.hajnina.scanlist.embed

/**
 * The embedder's proof of correct output (card S5), run on every backend a ladder opens:
 *
 *  1. the three fixed sentences rank right — the query must be closer to the related sentence than to
 *     the unrelated one;
 *  2. every returned vector must equal the CPU reference vectors of the same model file
 *     ([GoldenVectors], cosine ≥ 0.98). That second check is the one that catches a backend which
 *     "works" but returns numerically wrong values (RECIPE.md §2, MnemoThera issue #48).
 *
 * Ported from references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/engine/runner/EmbedRunner.kt
 * (`selfTest`, MnemoThera), with the audio branch dropped (ScanList has no audio path; the golden asset
 * still contains the tone vector, unused).
 *
 * No golden reference for the exact bundle means no proof: every GPU/NPU is refused and the CPU still
 * loads, with a [Result.warning] the caller logs (the CPU *is* the reference and the last resort).
 */
object SelfTest {

    data class Result(
        /** Cosine to the CPU reference per input ("query", "related", "unrelated"); empty when there is no reference. */
        val cosines: Map<String, Float>,
        /** Non-null when the CPU loaded without reference vectors (loud, never a silent pass). */
        val warning: String?,
    )

    /**
     * Embeds the fixed inputs on [engine] and returns its cosines. Throws [EmbedderException] when the
     * backend must be refused (wrong ranking, golden mismatch, missing reference on a non-CPU backend).
     */
    fun prove(
        engine: EmbedEngine,
        prompts: Prompts,
        golden: GoldenVectors?,
        nativeDims: Int,
        backend: EmbedBackend,
    ): Result {
        val query = embed(engine, prompts.query(GoldenVectors.QUERY), nativeDims, backend)
        val related = embed(engine, prompts.doc(GoldenVectors.RELATED), nativeDims, backend)
        val unrelated = embed(engine, prompts.doc(GoldenVectors.UNRELATED), nativeDims, backend)

        val simRelated = Vectors.cosine(query, related)
        val simUnrelated = Vectors.cosine(query, unrelated)
        if (!(simRelated > simUnrelated)) {
            throw EmbedderException(
                "text self-test failed on ${backend.id}: related ($simRelated) is not closer than unrelated ($simUnrelated)",
            )
        }

        if (golden == null) {
            val why = "no CPU reference vectors for this model file (bundled ${GoldenVectors.ASSET} missing, " +
                "malformed, or made for another sha256): ${backend.id} cannot be proven"
            if (!backend.isCpu) throw EmbedderException(why)
            return Result(emptyMap(), "$why; CPU loaded as the reference itself")
        }

        val cosines = LinkedHashMap<String, Float>()
        for ((name, vector) in listOf("query" to query, "related" to related, "unrelated" to unrelated)) {
            val reference = golden[name] ?: continue
            cosines[name] = Vectors.cosine(vector, reference)
            golden.mismatch(name, vector)?.let { throw EmbedderException("self-test failed on ${backend.id}: $it") }
        }
        return Result(cosines, null)
    }

    private fun embed(engine: EmbedEngine, prefixed: String, nativeDims: Int, backend: EmbedBackend): FloatArray {
        val v = engine.embedText(prefixed, nativeDims)
        if (v.size != nativeDims) {
            throw EmbedderException("self-test failed on ${backend.id}: engine returned ${v.size} dims, expected $nativeDims")
        }
        return v
    }
}
