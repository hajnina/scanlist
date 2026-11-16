package dev.hajnina.scanlist.embed

import android.content.Context
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.InputStream

/**
 * The task prefixes and dimensions from **`prompts.json`** — the single source of truth shared by every
 * track (card S2/S3). This class never hard-codes a prefix: `shared/spec/prompts.json` is bundled as
 * the module asset `prompts.json` (a copy; see README.md) and read at runtime, as the spec demands.
 *
 * `prompts.json` holds two candidate prefix sets, `mnemothera` and `modelcard`, and an `active` key.
 * Card S3 runs the golden retrieval A/B and flips `active`; consumers just re-read the file.
 *
 * Rule from the spec (`rules.apply`): `prefix + trim(text)` with leading/trailing **Unicode
 * whitespace** only — no case folding, no punctuation stripping. Kotlin's `String.trim()` trims
 * `Char.isWhitespace()`, which is exactly that. Images take `imagePrefix`, which is empty today.
 */
data class Prompts(
    val version: Int,
    val model: String,
    val nativeDims: Int,
    val activeDims: Int,
    val matryoshka: List<Int>,
    val imagePrefix: String,
    val active: String,
    val queryPrefix: String,
    val docPrefix: String,
) {
    /** A document (shopping-list item) prompt. */
    fun doc(text: String): String = docPrefix + text.trim()

    /** A query (barcode name / OCR words) prompt. */
    fun query(text: String): String = queryPrefix + text.trim()

    /** An image prompt. Empty prefix today; kept here so the rule lives in one place. */
    fun image(): String = imagePrefix

    companion object {
        /** The bundled copy of `shared/spec/prompts.json`. */
        const val ASSET = "prompts.json"

        /** Used only if the file has no `active` key; matches shared/spec/prompts.json's current decision. */
        const val DEFAULT_ACTIVE = "modelcard"

        private val KNOWN_SETS = setOf("mnemothera", "modelcard")

        /** Parses the JSON. Throws [IllegalArgumentException] with what is missing when the file is not usable. */
        fun parse(json: String): Prompts {
            val root = JsonParser.parseString(json).asJsonObject
            val active = root.stringOrNull("active")?.takeIf { it.isNotBlank() } ?: DEFAULT_ACTIVE
            require(active in KNOWN_SETS) {
                "prompts.json: unknown prefix set '$active' (expected one of ${KNOWN_SETS.joinToString()})"
            }
            val set: JsonObject = root.getAsJsonObject(active)
                ?: throw IllegalArgumentException("prompts.json: no '$active' object with the prefixes")
            val query = set.stringOrNull("query")
                ?: throw IllegalArgumentException("prompts.json: '$active' has no query prefix")
            val doc = set.stringOrNull("doc")
                ?: throw IllegalArgumentException("prompts.json: '$active' has no doc prefix")
            val dims = root.getAsJsonObject("dims")
                ?: throw IllegalArgumentException("prompts.json: no 'dims' object")
            val native = dims.intOrNull("native") ?: 768
            val activeDims = dims.intOrNull("active") ?: 256
            val matryoshka = dims.getAsJsonArray("matryoshka")?.map { it.asInt } ?: listOf(512, 256, 128)
            return Prompts(
                version = root.intOrNull("version") ?: 0,
                model = root.stringOrNull("model") ?: "embeddinggemma-2-740m",
                nativeDims = native,
                activeDims = activeDims,
                matryoshka = matryoshka,
                imagePrefix = root.stringOrNull("imagePrefix") ?: "",
                active = active,
                queryPrefix = query,
                docPrefix = doc,
            )
        }

        fun load(input: InputStream): Prompts = input.bufferedReader(Charsets.UTF_8).use { parse(it.readText()) }

        /** Reads the bundled asset. Call from a background thread or during setup, not per embed call. */
        fun load(context: Context): Prompts = context.assets.open(ASSET).use { load(it) }

        private fun JsonObject.stringOrNull(key: String): String? =
            get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

        private fun JsonObject.intOrNull(key: String): Int? =
            get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt
    }
}
