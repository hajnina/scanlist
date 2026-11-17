package dev.hajnina.scanlist.kotlin.scan.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B5's **pool-order** decision (B4-sync's verified risk): the ranker keeps the first 16 text
 * queries in arrival order, so the OFF barcode text must own slot 1 and the extra OCR **lines** are
 * the ones dropped — never the barcode. A 17th candidate is exactly the bug this class prevents.
 */
class SignalPoolTest {

    @Test
    fun `the barcode text is always slot one and OCR keeps arrival order`() {
        val pool = SignalPool()
        pool.acceptBarcode("3017620422003", 0)
        pool.acceptBarcodeText("Nutella", 1)
        pool.acceptOcr("milk", 2)
        pool.acceptOcr("bread", 3)
        assertEquals(listOf("Nutella", "milk", "bread"), pool.textQueries())
    }

    @Test
    fun `a barcode arriving after 16 OCR lines still occupies slot one - the risk case`() {
        val pool = SignalPool()
        val lines = (1..16).map { "line $it" }
        for ((index, line) in lines.withIndex()) pool.acceptOcr(line, index.toLong())
        assertEquals(16, pool.textQueries().size)
        assertEquals(lines, pool.textQueries())

        // The 17th text candidate is the barcode's OFF name: it must win, and the last OCR line drops.
        pool.acceptBarcode("3017620422003", 20)
        pool.acceptBarcodeText("Nutella", 21)
        val queries = pool.textQueries()
        assertEquals(16, queries.size)
        assertEquals("Nutella", queries.first())
        assertEquals(lines.take(15), queries.drop(1))
        assertFalse("the 16th OCR line is the one dropped", queries.contains("line 16"))
    }

    @Test
    fun `the barcode text is never embedded twice and the raw digits never at all`() {
        val pool = SignalPool()
        pool.acceptBarcode("3017620422003", 0)
        pool.acceptBarcodeText("Nutella", 1)
        pool.acceptOcr("Nutella", 2)
        pool.acceptOcr("3017620422003", 3)
        pool.acceptOcr("hazelnut spread", 4)
        assertEquals(listOf("Nutella", "hazelnut spread"), pool.textQueries())
        assertEquals("the raw digits were rejected at the door, not pooled", 2, pool.ocrSize)
    }

    @Test
    fun `OCR re-reads refresh the position and age instead of duplicating`() {
        val pool = SignalPool(maxTextQueries = 3)
        pool.acceptOcr("a", 0)
        pool.acceptOcr("b", 1)
        pool.acceptOcr("c", 2)
        assertEquals(listOf("a", "b", "c"), pool.textQueries())
        assertTrue(pool.acceptOcr("a", 3))
        assertEquals("a is the newest arrival now", listOf("b", "c", "a"), pool.textQueries())
        // A fourth line pushes out the oldest remaining ("b").
        pool.acceptOcr("d", 4)
        assertEquals(listOf("c", "a", "d"), pool.textQueries())
        assertEquals(3, pool.ocrSize)
    }

    @Test
    fun `blank OCR and blank barcodes are ignored`() {
        val pool = SignalPool()
        assertFalse(pool.acceptOcr("", 0))
        assertFalse(pool.acceptOcr("   ", 0))
        assertFalse(pool.acceptBarcode("", 0))
        assertFalse(pool.acceptBarcode("  ", 0))
        assertTrue(pool.textQueries().isEmpty())
        assertNull(pool.barcode)
    }

    @Test
    fun `a new product drops the previous OFF name, the same product keeps it`() {
        val pool = SignalPool()
        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcodeText("Milk", 1)
        assertEquals("Milk", pool.barcodeText)
        assertFalse("the same barcode is not a new product", pool.acceptBarcode("11111111", 2))
        assertEquals("Milk", pool.barcodeText)
        assertTrue("a different barcode is a new product", pool.acceptBarcode("22222222", 3))
        assertNull("the old OFF name must not leak to the new product", pool.barcodeText)
        assertEquals(listOf<String>(), pool.textQueries())
    }

    @Test
    fun `OFF answers are trimmed and blank answers mean "no barcode text"`() {
        val pool = SignalPool()
        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcodeText("  Nutella  ", 1)
        assertEquals("Nutella", pool.barcodeText)
        pool.acceptBarcodeText("   ", 2)
        assertNull(pool.barcodeText)
        pool.acceptBarcodeText(null, 3)
        assertNull(pool.barcodeText)
    }

    @Test
    fun `OCR words expire at the 3 s boundary and a re-read keeps them alive`() {
        val pool = SignalPool()
        pool.acceptOcr("milk", 0)
        assertEquals(listOf("milk"), pool.textQueries(2_999))
        assertEquals("exactly the TTL is stale", emptyList<String>(), pool.textQueries(3_000))
        pool.acceptOcr("milk", 3_500)
        assertEquals(listOf("milk"), pool.textQueries(6_499))
        assertEquals(emptyList<String>(), pool.textQueries(6_500))
    }

    @Test
    fun `the image is fresh for 2_5 s and the barcode name for 30 s`() {
        val pool = SignalPool()
        pool.noteImage(1_000)
        assertTrue(pool.imageFresh(3_499))
        assertFalse(pool.imageFresh(3_500))

        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcodeText("Milk", 0)
        assertTrue(pool.barcodeFresh(29_999))
        assertFalse(pool.barcodeFresh(30_000))
        pool.expire(30_000)
        assertNull(pool.barcode)
        assertNull("the OFF name expires with its barcode", pool.barcodeText)
        assertFalse(pool.barcodeFresh(30_001))
    }

    @Test
    fun `a barcode re-read refreshes its own age`() {
        val pool = SignalPool()
        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcode("11111111", 20_000)
        pool.expire(29_999)
        assertEquals("11111111", pool.barcode)
        pool.expire(50_000)
        assertNull(pool.barcode)
    }

    @Test
    fun `textQueries without a clock does not expire, with one it does`() {
        val pool = SignalPool()
        pool.acceptOcr("milk", 0)
        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcodeText("Milk", 0)
        // No clock argument: nothing expires, the caller owns the timeline.
        assertEquals(2, pool.textQueries().size)
        // With a clock, the same call expires both the OCR line and the barcode name.
        assertEquals(emptyList<String>(), pool.textQueries(100_000))
        assertNull(pool.barcode)
    }

    @Test
    fun `the custom cap counts the barcode text too`() {
        val pool = SignalPool(maxTextQueries = 3)
        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcodeText("Milk", 1)
        pool.acceptOcr("a", 2)
        pool.acceptOcr("b", 3)
        pool.acceptOcr("c", 4)
        assertEquals(listOf("Milk", "a", "b"), pool.textQueries())
    }

    @Test
    fun `clear forgets barcode, OFF name, OCR and the frame`() {
        val pool = SignalPool()
        pool.acceptBarcode("11111111", 0)
        pool.acceptBarcodeText("Milk", 0)
        pool.acceptOcr("milk", 0)
        pool.noteImage(0)
        assertTrue(pool.imageFresh(1))
        pool.clear()
        assertNull(pool.barcode)
        assertNull(pool.barcodeText)
        assertEquals(0, pool.ocrSize)
        assertTrue(pool.ocrLines().isEmpty())
        assertFalse(pool.imageFresh(1))
        assertEquals(emptyList<String>(), pool.textQueries())
    }

    @Test
    fun `knowsOcr answers for trimmed re-reads and rejects blanks`() {
        val pool = SignalPool()
        pool.acceptOcr("  milk ", 0)
        assertTrue(pool.knowsOcr("milk"))
        assertFalse(pool.knowsOcr("  bread "))
        assertEquals(setOf("milk"), pool.ocrLines())
    }
}
