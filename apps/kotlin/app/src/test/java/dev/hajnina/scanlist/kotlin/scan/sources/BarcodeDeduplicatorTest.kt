package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Card B4: same barcode within N seconds is suppressed, different values are not. */
class BarcodeDeduplicatorTest {

    @Test
    fun `repeat inside the window is suppressed`() {
        val clock = FakeClock()
        val dedupe = BarcodeDeduplicator(clock)

        assertTrue(dedupe.accept("5012345678900"))
        clock.advance(1_000)
        assertFalse(dedupe.accept("5012345678900"))
        clock.advance(1_999)
        assertFalse(dedupe.accept("5012345678900"))
    }

    @Test
    fun `the same barcode is accepted again after the window`() {
        val clock = FakeClock()
        val dedupe = BarcodeDeduplicator(clock)

        assertTrue(dedupe.accept("5012345678900"))
        clock.advance(BarcodeDeduplicator.DEFAULT_WINDOW_MS)
        assertTrue(dedupe.accept("5012345678900"))
    }

    @Test
    fun `different barcodes never suppress each other`() {
        val clock = FakeClock()
        val dedupe = BarcodeDeduplicator(clock)

        assertTrue(dedupe.accept("111"))
        assertTrue(dedupe.accept("222"))
        assertFalse(dedupe.accept("111"))
    }

    @Test
    fun `whitespace is trimmed before comparing`() {
        val clock = FakeClock()
        val dedupe = BarcodeDeduplicator(clock)

        assertTrue(dedupe.accept(" 4006381333931 "))
        assertFalse(dedupe.accept("4006381333931"))
    }

    @Test
    fun `blank values are ignored`() {
        val dedupe = BarcodeDeduplicator(FakeClock())
        assertFalse(dedupe.accept(""))
        assertFalse(dedupe.accept("   "))
    }

    @Test
    fun `reset clears the window`() {
        val clock = FakeClock()
        val dedupe = BarcodeDeduplicator(clock)
        assertTrue(dedupe.accept("111"))
        dedupe.reset()
        assertTrue(dedupe.accept("111"))
    }
}
