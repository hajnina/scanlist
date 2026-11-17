package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Card B4: OCR line batching — normalise, drop noise, join, suppress repeats, cap length. */
class OcrLineBatcherTest {

    @Test
    fun `lines are trimmed, collapsed, deduped and joined`() {
        val batcher = OcrLineBatcher()
        val text = batcher.batch(listOf("  Fresh   milk ", "1 L", "Fresh milk", "", "a"))
        assertEquals("Fresh milk | 1 L", text)
    }

    @Test
    fun `no visible words yields nothing`() {
        val batcher = OcrLineBatcher()
        assertNull(batcher.batch(emptyList()))
        assertNull(batcher.batch(listOf(" ", ".", "x")))
    }

    @Test
    fun `identical text is suppressed inside the repeat window`() {
        val batcher = OcrLineBatcher()
        assertEquals("Olive oil", batcher.batch(listOf("Olive oil"), nowMs = 0))
        assertNull(batcher.batch(listOf("Olive oil"), nowMs = 500))
        assertNull(batcher.batch(listOf("Olive  oil"), nowMs = 1_499))
    }

    @Test
    fun `identical text is re-emitted after the window`() {
        val batcher = OcrLineBatcher()
        assertEquals("Olive oil", batcher.batch(listOf("Olive oil"), nowMs = 0))
        assertEquals("Olive oil", batcher.batch(listOf("Olive oil"), nowMs = 1_500))
    }

    @Test
    fun `different text is emitted immediately`() {
        val batcher = OcrLineBatcher()
        assertEquals("Olive oil", batcher.batch(listOf("Olive oil"), nowMs = 0))
        assertEquals("Basil", batcher.batch(listOf("Basil"), nowMs = 10))
    }

    @Test
    fun `result is capped without splitting a line`() {
        val batcher = OcrLineBatcher(maxChars = 12)
        val text = batcher.batch(listOf("abcdefghij", "klmno"), nowMs = 0)
        assertEquals("abcdefghij", text)
    }

    @Test
    fun `a single over-long line is truncated to the cap`() {
        val batcher = OcrLineBatcher(maxChars = 5)
        assertEquals("abcde", batcher.batch(listOf("abcdefghij"), nowMs = 0))
    }

    @Test
    fun `reset allows the same text again immediately`() {
        val batcher = OcrLineBatcher()
        assertEquals("Milk", batcher.batch(listOf("Milk"), nowMs = 0))
        batcher.reset()
        assertEquals("Milk", batcher.batch(listOf("Milk"), nowMs = 1))
    }
}
