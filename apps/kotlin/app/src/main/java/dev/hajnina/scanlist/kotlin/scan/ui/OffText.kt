package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.rank.fullCasefold
import java.text.Normalizer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * OFF.md §3 — barcode → the one plain text string the ranker may use (card B5, contract from S4).
 *
 * Deliberately literal: NFC only, every Unicode whitespace **run** → one space, trim U+0020, then
 * `product_name` → `generic_name` → `brands` (never concatenated), hard cut at 160 **code points**.
 * No case folding, no punctuation or accent stripping, no size/quantity trimming — the three tracks
 * must derive the same string from the same response, and `shared/off/fixtures/cases.json` is the
 * oracle (this class is replayed against every recorded fixture by `OffTextTest`).
 */
object OffText {

    /** OFF.md §3.1 step 3: the Unicode `White_Space` set, every maximal run. */
    private val WHITESPACE = Regex(
        "[\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]+",
    )

    /** OFF.md §3.3: 160 code points, not UTF-16 units and not bytes. */
    const val MAX_CODE_POINTS: Int = 160

    /** OFF.md §3.1 `clean(v)`: non-strings are "", NFC, whitespace runs → " ", strip spaces. */
    fun clean(value: String?): String {
        if (value == null) return ""
        val normalised = Normalizer.normalize(value, Normalizer.Form.NFC)
        return WHITESPACE.replace(normalised, " ").trim(' ')
    }

    /**
     * OFF.md §3.1 `clean_brands(v)`: clean, split on `,` only, clean each piece, drop empties,
     * de-duplicate by casefold keeping the first spelling, join with `", "`.
     */
    fun cleanBrands(value: String?): String {
        val whole = clean(value)
        if (whole.isEmpty()) return ""
        val seen = HashSet<String>()
        val out = ArrayList<String>(4)
        for (piece in whole.split(',')) {
            val part = clean(piece)
            if (part.isEmpty()) continue
            if (!seen.add(fullCasefold(part))) continue
            out += part
        }
        return out.joinToString(", ")
    }

    /** OFF.md §3.2/§3.3: the first non-empty of product_name → generic_name → brands, cut to 160. */
    fun derive(product: JsonObject?): String? {
        if (product == null) return null
        val candidates = listOf(
            clean(stringField(product, "product_name")),
            clean(stringField(product, "generic_name")),
            cleanBrands(stringField(product, "brands")),
        )
        val winner = candidates.firstOrNull { it.isNotEmpty() } ?: return null
        return truncate(winner)
    }

    /** OFF.md §3.3: hard cut at [MAX_CODE_POINTS] code points, then trailing spaces removed. */
    fun truncate(text: String): String {
        if (text.isEmpty()) return ""
        val codePoints = text.codePoints().toArray()
        val cut = if (codePoints.size > MAX_CODE_POINTS) String(codePoints, 0, MAX_CODE_POINTS) else text
        return cut.trimEnd(' ')
    }

    /** Only JSON strings carry text (OFF.md §3.1 step 1: numbers/arrays/null are absent). */
    private fun stringField(product: JsonObject, key: String): String? {
        val primitive = product[key] as? JsonPrimitive ?: return null
        return if (primitive.isString) primitive.content else null
    }
}
