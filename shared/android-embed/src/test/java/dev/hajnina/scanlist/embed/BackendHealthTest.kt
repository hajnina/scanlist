package dev.hajnina.scanlist.embed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Strike / block logic (card S5), ported from MnemoThera's BackendGuard: two strikes block a backend
 * that was never proven, three block a proven one, the CPU is never blocked, and a clean close clears
 * the strikes of a backend that survived its work.
 */
class BackendHealthTest {

    private val store = InMemoryBackendStore()
    private var clock = 1_000L
    private fun health(model: String = "m") = BackendHealth(model, store) { clock++ }

    @Test
    fun aNeverProvenGpuIsBlockedAfterTwoStrikes() {
        val h = health()
        assertFalse(h.blocked(EmbedBackend.GPU))
        h.strike(EmbedBackend.GPU, "boom")
        assertFalse("one strike is a warning, not a verdict", h.blocked(EmbedBackend.GPU))
        assertEquals(1, h.record(EmbedBackend.GPU)!!.strikes)
        h.strike(EmbedBackend.GPU, "boom again")
        assertTrue(h.blocked(EmbedBackend.GPU))
        assertEquals(2, h.record(EmbedBackend.GPU)!!.strikes)
    }

    @Test
    fun aProvenGpuGetsThreeStrikes() {
        val h = health()
        h.proven(EmbedBackend.GPU)
        h.strike(EmbedBackend.GPU, "transient")
        h.strike(EmbedBackend.GPU, "transient")
        assertFalse("a proven backend's failure is treated as transient", h.blocked(EmbedBackend.GPU))
        h.strike(EmbedBackend.GPU, "third")
        assertTrue(h.blocked(EmbedBackend.GPU))
    }

    @Test
    fun theCpuIsNeverBlockedEvenAfterManyStrikes() {
        val h = health()
        repeat(10) { h.strike(EmbedBackend.CPU, "killed for memory") }
        assertFalse(h.blocked(EmbedBackend.CPU))
        assertEquals(10, h.record(EmbedBackend.CPU)!!.strikes)
        assertEquals(EmbedBackend.CPU, EmbedBackend.fromId("cpu"))
        assertTrue(EmbedBackend.CPU.isCpu)
    }

    @Test
    fun aCleanCloseClearsTheStrikesOfAProvenBackend() {
        val h = health()
        h.strike(EmbedBackend.GPU, "first")
        h.proven(EmbedBackend.GPU)
        assertEquals(1, h.record(EmbedBackend.GPU)!!.strikes)
        h.cleanClose(EmbedBackend.GPU)
        assertEquals(0, h.record(EmbedBackend.GPU)!!.strikes)
        assertFalse(h.record(EmbedBackend.GPU)!!.blocked)
        assertEquals("loaded and closed cleanly", h.record(EmbedBackend.GPU)!!.reason)
    }

    @Test
    fun aCleanCloseDoesNotForgiveANeverProvenBackend() {
        val h = health()
        h.strike(EmbedBackend.GPU, "never loaded")
        h.cleanClose(EmbedBackend.GPU)
        assertEquals(1, h.record(EmbedBackend.GPU)!!.strikes)
        assertFalse(h.record(EmbedBackend.GPU)!!.everProven)
    }

    @Test
    fun aCpuCleanCloseDoesNothing() {
        health().apply {
            strike(EmbedBackend.CPU, "x")
            cleanClose(EmbedBackend.CPU)
            assertEquals(1, record(EmbedBackend.CPU)!!.strikes)
        }
    }

    @Test
    fun resetForgetsEverythingForThatModel() {
        val h = health()
        h.strike(EmbedBackend.GPU, "x")
        h.strike(EmbedBackend.GPU, "y")
        assertTrue(h.blocked(EmbedBackend.GPU))
        h.reset()
        assertFalse(h.blocked(EmbedBackend.GPU))
        assertNull(h.record(EmbedBackend.GPU))
    }

    @Test
    fun recordsArePerModel() {
        val other = health("other-model")
        health().apply {
            strike(EmbedBackend.GPU, "x")
            strike(EmbedBackend.GPU, "y")
        }
        assertTrue(health().blocked(EmbedBackend.GPU))
        assertFalse("another model's history must not block this one", other.blocked(EmbedBackend.GPU))
    }

    @Test
    fun aStrikeSurvivesARestartBecauseItIsInTheStore() {
        val first = health()
        first.strike(EmbedBackend.GPU, "x")
        first.strike(EmbedBackend.GPU, "y")
        // A new process reads the same store.
        val afterRestart = BackendHealth("m", store) { clock++ }
        assertTrue(afterRestart.blocked(EmbedBackend.GPU))
        assertEquals(2, afterRestart.record(EmbedBackend.GPU)!!.strikes)
    }

    @Test
    fun aReasonWithAPipeCannotBreakTheRecord() {
        val h = health()
        h.strike(EmbedBackend.GPU, "driver says a|b|c")
        assertEquals(1, h.record(EmbedBackend.GPU)!!.strikes)
        assertTrue(h.record(EmbedBackend.GPU)!!.reason.contains("a/b/c"))
    }
}
