package dev.hajnina.scanlist.embed

import android.content.Context
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * CPU reference vectors for the fixed self-test inputs (card S5), keyed by the **model file's sha256**.
 *
 * Copied from references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/embed/EmbedGolden.kt
 * (MnemoThera) and its `assets/embed_golden.json` (recorded on a Pixel 8 CPU run for
 * `embeddinggemma-2-740m.litertlm`, sha256 `e7a8a220…f4c`). The bundled asset is a verbatim copy; see
 * README.md for provenance.
 *
 * Why a golden comparison at all: "related ranks above unrelated" is not proof — a GPU that returns
 * wrong numbers can still rank three sentences the right way (RECIPE.md §2, MnemoThera issue #48). A
 * vector whose cosine to the CPU reference is under [MIN_COSINE] fails the backend's proof, it takes a
 * strike and the ladder moves on.
 *
 * Unrelated sentences score 0.75-0.89 against each other, so a threshold near 0.9 would catch
 * nothing; 0.98 sits where only numerically equivalent output passes (the phones measured ≥ 0.997).
 */
class GoldenVectors(val sha256: String, val vectors: Map<String, FloatArray>) {

    /** Why [v] is wrong for [name], or null when it matches (or this asset has no vector for that name). */
    fun mismatch(name: String, v: FloatArray): String? {
        val ref = vectors[name] ?: return null
        val c = Vectors.cosine(v, ref)
        return if (c >= MIN_COSINE) {
            null
        } else {
            "output for '$name' differs from the CPU reference (cosine ${"%.4f".format(c)}, at least $MIN_COSINE expected)"
        }
    }

    /** The reference vector for a self-test input, when present. */
    operator fun get(name: String): FloatArray? = vectors[name]

    companion object {
        /** The bundled copy of MnemoThera's `assets/embed_golden.json`. */
        const val ASSET = "embed_golden.json"

        /** A backend must reproduce the CPU vectors at least this closely (RECIPE.md §2). */
        const val MIN_COSINE = 0.98f

        /** Self-test inputs, copied verbatim from EmbedGolden.kt so they match the reference vectors. */
        const val QUERY = "my boss keeps criticising my work"
        const val RELATED = "my manager is always unhappy with my reports"
        const val UNRELATED = "we went hiking in the mountains last weekend"

        /** Audio self-test input; present in the golden file, unused by ScanList (no audio path). */
        const val TONE = "tone"

        /**
         * Parses the asset. Returns null when [expectedSha256] is given and does not match the file the
         * vectors were made for: a reference for another bundle must never be used.
         */
        fun parse(json: String, expectedSha256: String? = null): GoldenVectors? {
            val root = JsonParser.parseString(json).asJsonObject
            val sha = root.stringOrNull("sha256") ?: return null
            if (expectedSha256 != null && !sha.equals(expectedSha256, ignoreCase = true)) return null
            val vs: JsonObject = root.getAsJsonObject("vectors") ?: return null
            val vectors = LinkedHashMap<String, FloatArray>()
            for (key in vs.keySet()) {
                val array = vs.getAsJsonArray(key) ?: return null
                vectors[key] = FloatArray(array.size()) { array.get(it).asFloat }
            }
            return GoldenVectors(sha, vectors)
        }

        /** Reads the bundled asset; null when it is missing, malformed, or made for another model file. */
        fun load(context: Context, expectedSha256: String?): GoldenVectors? =
            runCatching { context.assets.open(ASSET).use { input -> parse(input.bufferedReader(Charsets.UTF_8).readText(), expectedSha256) } }.getOrNull()

        private fun JsonObject.stringOrNull(key: String): String? =
            get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
    }
}
