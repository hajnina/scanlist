package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B4 + B4-sync: RANK.md §2.2 — **each OCR line is its own text query**, in detection order,
 * at most 16 per frame, with per-line repeat suppression and per-line confidence (never averaged).
 */
class OcrLineBatcherTest {

    @Test
    fun `one visible line becomes one normalised line`() {
        val batcher = OcrLineBatcher()
        assertEquals(
            listOf("Fresh milk"),
            batcher.batch(listOf(OcrLine("  Fresh   milk ")), nowMs = 0).map { it.text },
        )
    }

    @Test
    fun `each line is its own signal in detection order`() {
        val batcher = OcrLineBatcher()
        val out = batcher.batch(
            listOf(OcrLine("Fresh milk"), OcrLine("1 L"), OcrLine("Whole")),
            nowMs = 0,
        )
        assertEquals(listOf("Fresh milk", "1 L", "Whole"), out.map { it.text })
    }

    @Test
    fun `junk and duplicate lines are dropped`() {
        val batcher = OcrLineBatcher()
        val out = batcher.batch(
            listOf(OcrLine("  Fresh   milk "), OcrLine(" "), OcrLine("."), OcrLine("x"), OcrLine("Fresh milk")),
            nowMs = 0,
        )
        assertEquals(listOf("Fresh milk"), out.map { it.text })
    }

    @Test
    fun `no visible words yields nothing`() {
        val batcher = OcrLineBatcher()
        assertTrue(batcher.batch(emptyList()).isEmpty())
        assertTrue(batcher.batch(listOf(OcrLine(" "), OcrLine("."), OcrLine("x"))).isEmpty())
    }

    @Test
    fun `a line already emitted is suppressed inside the repeat window`() {
        val batcher = OcrLineBatcher()
        assertEquals(listOf("Olive oil"), batcher.batch(listOf(OcrLine("Olive oil")), nowMs = 0).map { it.text })
        assertTrue(batcher.batch(listOf(OcrLine("Olive oil")), nowMs = 500).isEmpty())
        assertTrue(batcher.batch(listOf(OcrLine("Olive  oil")), nowMs = 1_499).isEmpty())
    }

    @Test
    fun `a line is re-emitted after the window`() {
        val batcher = OcrLineBatcher()
        assertEquals(listOf("Olive oil"), batcher.batch(listOf(OcrLine("Olive oil")), nowMs = 0).map { it.text })
        assertEquals(listOf("Olive oil"), batcher.batch(listOf(OcrLine("Olive oil")), nowMs = 1_500).map { it.text })
    }

    @Test
    fun `the repeat window is per line not per frame`() {
        val batcher = OcrLineBatcher()
        val first = batcher.batch(listOf(OcrLine("Olive oil"), OcrLine("Basil")), nowMs = 0)
        assertEquals(listOf("Olive oil", "Basil"), first.map { it.text })

        // Both lines are still inside their own window, so the whole frame is suppressed.
        assertTrue(batcher.batch(listOf(OcrLine("Olive oil"), OcrLine("Basil")), nowMs = 1_000).isEmpty())

        // "Basil" left the frame and comes back after the window: it is emitted, "Olive oil" too.
        val again = batcher.batch(listOf(OcrLine("Olive oil"), OcrLine("Basil")), nowMs = 1_600)
        assertEquals(listOf("Olive oil", "Basil"), again.map { it.text })
    }

    @Test
    fun `maxChars truncates a single line, not the frame`() {
        val batcher = OcrLineBatcher(maxChars = 5)
        val out = batcher.batch(listOf(OcrLine("abcdefghij"), OcrLine("klmno")), nowMs = 0)
        assertEquals(listOf("abcde", "klmno"), out.map { it.text })
    }

    @Test
    fun `at most 16 lines per frame are emitted in detection order`() {
        val batcher = OcrLineBatcher()
        val input = (1..20).map { n -> OcrLine("line %02d".format(n)) }
        val out = batcher.batch(input, nowMs = 0)

        assertEquals(OcrLineBatcher.MAX_LINES_PER_FRAME, out.size)
        assertEquals(16, out.size)
        assertEquals((1..16).map { "line %02d".format(it) }, out.map { it.text })
    }

    @Test
    fun `confidence is per line and never averaged`() {
        val batcher = OcrLineBatcher()
        val out = batcher.batch(
            listOf(OcrLine("Fresh milk", 0.9f), OcrLine("1 L", 0.3f)),
            nowMs = 0,
        )
        assertEquals(listOf(0.9f, 0.3f), out.map { it.confidence })
        assertEquals("Fresh milk", out[0].text)
    }

    @Test
    fun `reset allows the same line again immediately`() {
        val batcher = OcrLineBatcher()
        assertEquals(listOf("Milk"), batcher.batch(listOf(OcrLine("Milk")), nowMs = 0).map { it.text })
        batcher.reset()
        assertEquals(listOf("Milk"), batcher.batch(listOf(OcrLine("Milk")), nowMs = 1).map { it.text })
    }

    @Test(expected = IllegalArgumentException::class)
    fun `out-of-range per-line confidence is rejected`() {
        OcrLine("Milk", 1.5f)
    }
}
