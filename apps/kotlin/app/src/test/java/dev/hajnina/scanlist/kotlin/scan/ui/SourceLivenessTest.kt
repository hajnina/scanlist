package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.scan.sources.ScanKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The source chips (card B5 / Barcode Buddy note): a chip is lit for a sticky window after its
 * source fired, so one decoded barcode stays visible while the user reads the hero card, and `clear`
 * (one tick) is the "auto-revert" half of the pattern.
 */
class SourceLivenessTest {

    @Test
    fun `nothing is lit before a source fires`() {
        val liveness = SourceLiveness()
        for (kind in ScanKind.entries) assertFalse(liveness.lit(kind, 0))
    }

    @Test
    fun `a chip stays lit for the sticky window and goes dark at the boundary`() {
        val liveness = SourceLiveness(stickyMs = 4_000)
        liveness.fire(ScanKind.BARCODE, 100)
        liveness.fire(ScanKind.TEXT, 200)
        assertTrue(liveness.lit(ScanKind.BARCODE, 100))
        assertTrue(liveness.lit(ScanKind.BARCODE, 4_099))
        assertFalse("exactly stickyMs is already dark", liveness.lit(ScanKind.BARCODE, 4_100))
        assertTrue(liveness.lit(ScanKind.TEXT, 4_199))
        assertFalse(liveness.lit(ScanKind.TEXT, 4_200))
        assertFalse("a source that never fired stays dark", liveness.lit(ScanKind.IMAGE, 200))
    }

    @Test
    fun `firing again restarts the window`() {
        val liveness = SourceLiveness(stickyMs = 1_000)
        liveness.fire(ScanKind.TEXT, 0)
        liveness.fire(ScanKind.TEXT, 900)
        assertTrue(liveness.lit(ScanKind.TEXT, 1_800))
        assertFalse(liveness.lit(ScanKind.TEXT, 1_900))
    }

    @Test
    fun `clear is the one tick revert - every chip goes dark at once`() {
        val liveness = SourceLiveness(stickyMs = 10_000)
        for (kind in ScanKind.entries) liveness.fire(kind, 0)
        assertTrue(liveness.lit(ScanKind.BARCODE, 1))
        liveness.clear()
        for (kind in ScanKind.entries) assertFalse(liveness.lit(kind, 1))
        // The next signal lights its own chip again.
        liveness.fire(ScanKind.IMAGE, 2)
        assertTrue(liveness.lit(ScanKind.IMAGE, 2))
        assertFalse(liveness.lit(ScanKind.TEXT, 2))
    }
}
