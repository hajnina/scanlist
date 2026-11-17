package dev.hajnina.scanlist.kotlin.scan.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * OFF.md §3, replayed against every recorded real response in `shared/off/fixtures/cases.json`
 * (the S4 oracle: 17 hits + 2 misses, hand-written `expectedQueryText`, not generated). This is the
 * cross-track parity check for the barcode → query string, so a Kotlin derivation that drifts from
 * the RN/Python tracks fails here without a device or a network call.
 */
class OffTextTest {

    @Test
    fun `every recorded OFF response derives the oracle query text`() {
        val cases = Json.parseToJsonElement(repoFile("shared/off/fixtures/cases.json").readText()).jsonObject
            .getValue("cases").jsonArray
        assertEquals("the fixture set is the 19 recorded cases", 19, cases.size)
        for (case in cases) {
            val obj = case.jsonObject
            val barcode = obj.getValue("barcode").jsonPrimitive.content
            val httpStatus = obj.getValue("httpStatus").jsonPrimitive.content.toInt()
            val outcome = obj.getValue("outcome").jsonPrimitive.content
            val expected = obj["expectedQueryText"]?.jsonPrimitive?.content
            val body = repoFile("shared/off/fixtures/${obj.getValue("file").jsonPrimitive.content}")
                .readText(Charsets.UTF_8)

            val classified = OffResponse.classify(httpStatus, body)
            when (outcome) {
                "hit" -> {
                    assertEquals("$barcode outcome", OffOutcome.HIT, classified.outcome)
                    assertEquals("$barcode query text", expected, classified.text)
                }
                "miss" -> {
                    assertEquals("$barcode outcome", OffOutcome.MISS, classified.outcome)
                    assertNull("$barcode has no query text", classified.text)
                }
                else -> throw AssertionError("unknown fixture outcome '$outcome' for $barcode")
            }
        }
    }

    @Test
    fun `clean is NFC, collapses every Unicode whitespace run and trims spaces only`() {
        assertEquals("é", OffText.clean("e\u0301"))
        assertEquals("milk bread", OffText.clean("  milk\t\n\u000B\u000C\r bread  "))
        assertEquals("a b", OffText.clean("a\u00A0\u2007\u202F\u3000b"))
        assertEquals("", OffText.clean(null))
        assertEquals("", OffText.clean(" \t\n "))
        assertEquals("A B", OffText.clean("A  B"))
        assertEquals("a,b", OffText.clean("a,b"))
    }

    @Test
    fun `brands split on commas, drop empties and de-duplicate by full casefold`() {
        assertEquals("Nutella, Ferrero", OffText.cleanBrands("Nutella, nutella, NUTELLA, Ferrero"))
        assertEquals("Straße", OffText.cleanBrands("Straße, STRASSE"))
        assertEquals("a; b, c", OffText.cleanBrands(" a; b , , c "))
        assertEquals("", OffText.cleanBrands("  ,  , "))
        assertEquals("", OffText.cleanBrands(null))
    }

    @Test
    fun `derive prefers product name, then generic name, then brands`() {
        assertEquals("Nutella", OffText.derive(product("product_name" to "Nutella", "generic_name" to "Spread")))
        assertEquals("Spread", OffText.derive(product("product_name" to "   ", "generic_name" to "Spread")))
        assertEquals("Ferrero, Nutella", OffText.derive(product("brands" to "Ferrero, Nutella")))
        assertNull(OffText.derive(product("product_name" to "", "generic_name" to " ", "brands" to ",")))
        assertNull(OffText.derive(product()))
        assertNull(OffText.derive(null))
    }

    @Test
    fun `non-string fields are absent, never stringified`() {
        val product = buildJsonObject {
            put("product_name", 42)
            put("generic_name", true)
            put("brands", "Real Brand")
        }
        assertEquals("Real Brand", OffText.derive(product))
    }

    @Test
    fun `truncation is 160 code points, not UTF-16 units, and drops trailing spaces`() {
        val ascii = "a".repeat(160) + "bc"
        assertEquals("a".repeat(160), OffText.truncate(ascii))

        // 159 'a' + two emoji = 161 code points (163 UTF-16 units): the cut must keep one whole emoji.
        val emoji = "a".repeat(159) + "\uD83D\uDE00\uD83D\uDE00"
        assertEquals("a".repeat(159) + "\uD83D\uDE00", OffText.truncate(emoji))

        assertEquals("abc", OffText.truncate("abc   "))
        assertEquals("", OffText.truncate(""))
        assertEquals("short", OffText.truncate("short"))
    }

    @Test
    fun `a 160 code point cut never leaves a lone surrogate`() {
        val text = "\uD83D\uDE00".repeat(200)
        val cut = OffText.truncate(text)
        assertEquals(160, cut.codePointCount(0, cut.length))
        // Kotlin's String(int[], …) takes code points, so the result is well formed.
        assertEquals(160, cut.codePoints().toArray().size)
    }

    private fun product(vararg fields: Pair<String, String>) = buildJsonObject {
        for ((key, value) in fields) put(key, value)
    }
}
