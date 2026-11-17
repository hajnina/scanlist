package dev.hajnina.scanlist.kotlin.rank

import java.util.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RANK.md §3.1's **full** Unicode case folding, checked against Python's `str.casefold()`.
 *
 * `rank/casefold_unicode16.tsv` is an exhaustive Python 3.14.4 (Unicode 16.0.0) oracle: every code
 * point whose casefold differs from itself (1,557 lines; everything absent is identity). The test
 * walks all 1,112,064 code points, then fuzzes random strings built from the same per-code-point
 * oracle, so an engine/Unicode update that changes `lowercase(Locale.ROOT)` cannot silently change
 * `BARCODE_MATCH`.
 *
 * Scratch fuzz used to build the table (not run here): compare `str.casefold()` with
 * `String.toLowerCase(Locale.ROOT)` for every code point — minimum cases `ß→ss`, `İ→i̇`, `ﬁ→fi`.
 */
class CaseFoldTest {

    private val oracle: Map<Int, String> by lazy {
        val out = HashMap<Int, String>(2_000)
        resource("casefold_unicode16.tsv").lineSequence().forEach { line ->
            if (line.isEmpty() || line.startsWith("#")) return@forEach
            val (source, folded) = line.split('\t')
            out[source.removePrefix("U+").toInt(16)] =
                folded.split(' ').joinToString("") { String(Character.toChars(it.removePrefix("U+").toInt(16))) }
        }
        out
    }

    private fun expected(codePoint: Int): String = oracle[codePoint] ?: String(Character.toChars(codePoint))

    @Test
    fun `oracle table covers every non-identity full fold`() {
        assertEquals("Unicode 16 full case folding has 1,557 non-identity code points", 1_557, oracle.size)
        assertEquals("ss", oracle[0x00DF])
        assertEquals("i\u0307", oracle[0x0130])
        assertEquals("fi", oracle[0xFB01])
        assertEquals("ss", oracle[0x1E9E])
    }

    @Test
    fun `every one of the 1_112_064 code points folds exactly like Python`() {
        val failures = ArrayList<String>()
        for (cp in 0..0x10FFFF) {
            if (cp in 0xD800..0xDFFF) continue
            val have = fullCasefold(String(Character.toChars(cp)))
            val want = expected(cp)
            if (have != want) {
                failures += "U+%04X: %s != %s".format(cp, have.codePoints().toArray().joinToString(","), want.codePoints().toArray().joinToString(","))
                if (failures.size == 20) break
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun `random strings fold like the concatenated Python oracle`() {
        val tricky = intArrayOf(
            'A'.code, 'z'.code, 0x00DF, 0x1E9E, 0x0130, 0x0131, 0xFB01, 0xFB03, 0x03C2, 0x03A3,
            0x00B5, 0x0149, 0x01F0, 0x0390, 0x03B0, 0x0587, 0x13A0, 0xAB70, 0x13F8, 0x13F0,
            0x1F80, 0x1FB3, 0x1FF7, 0x1E96, 0x10400, 0x10428, 0x10570, 0x10597, 0x10D50, 0x10D70,
            0xA7C0, 0xA7C1, 0x2C2F, 0x2C5F, 0x16EA0,
        )
        val random = Random(0x5CA11)
        repeat(500) { case ->
            val length = random.nextInt(41)
            val codePoints = IntArray(length) {
                if (random.nextBoolean()) {
                    tricky[random.nextInt(tricky.size)]
                } else {
                    var cp: Int
                    do {
                        cp = random.nextInt(0x110000)
                    } while (cp in 0xD800..0xDFFF)
                    cp
                }
            }
            val input = codePoints.joinToString("") { String(Character.toChars(it)) }
            val want = codePoints.joinToString("") { expected(it) }
            assertEquals("case $case: ${codePoints.joinToString { "U+%04X".format(it) }}", want, fullCasefold(input))
        }
    }

    @Test
    fun `normBarcodeText applies NFC full folding and whitespace collapse`() {
        assertEquals("strasse fi", normBarcodeText("  Straße\u00a0ﬁ  "))
        assertEquals("i\u0307stanbul", normBarcodeText("İstanbul"))
        assertEquals("ss", normBarcodeText("ẞ"))
        assertEquals("é", normBarcodeText("e\u0301"))
        assertEquals("oat milk", normBarcodeText("Oat\u2003\tMILK"))
        assertEquals("", normBarcodeText(" \t\n "))
    }

    @Test
    fun `barcode matching uses the full fold for names and aliases`() {
        assertTrue(barcodeMatches("Straße", emptyList(), "STRASSE"))
        assertTrue(barcodeMatches("Milk", listOf("mléko"), "MLÉKO"))
        assertTrue(barcodeMatches("ﬁlter", emptyList(), "FILTER"))
        assertTrue(barcodeMatches("ΣΟΦΊΑ", emptyList(), "σοφία"))
        assertFalse(barcodeMatches("Milk", emptyList(), "Oat milk"))
    }

    private fun resource(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/rank/$name")) { "missing test resource /rank/$name" }
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
}
