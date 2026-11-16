package dev.hajnina.scanlist.embed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The GPU → CPU fallback ladder with a fake engine (card S5): a backend that cannot open or fails its
 * self-test is struck and the next one is tried, a blocked backend is never tried, and the CPU always
 * ends the walk.
 */
class BackendLadderTest {

    private val health = BackendHealth("m", InMemoryBackendStore())
    private val ladder = BackendLadder(health)
    private val order = listOf(EmbedBackend.GPU, EmbedBackend.CPU)

    @Test
    fun anOpenFailureFallsThroughToTheCpuInTheSameLoad() {
        val tried = ArrayList<EmbedBackend>()
        val loaded = ladder.load(
            model = "m",
            candidates = order,
            open = { b ->
                tried += b
                if (b == EmbedBackend.GPU) throw IllegalStateException("no OpenCL") else "cpu-engine"
            },
            prove = { _, _ -> },
            close = { },
        )
        assertEquals(EmbedBackend.CPU, loaded.backend)
        assertEquals(listOf(EmbedBackend.GPU, EmbedBackend.CPU), tried)
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)
        assertTrue(loaded.skipped.single().contains("no OpenCL"))
    }

    @Test
    fun aFailedSelfTestStrikesTheBackendAndClosesItsEngineOnce() {
        val gpu = FakeEngine { FloatArray(4) }
        val loaded = ladder.load(
            model = "m",
            candidates = order,
            open = { b -> if (b == EmbedBackend.GPU) gpu else "cpu-engine" },
            prove = { b, _ -> if (b == EmbedBackend.GPU) throw EmbedderException("self-test failed on gpu: wrong numbers") },
            close = { if (it === gpu) gpu.close() },
        )
        assertEquals(EmbedBackend.CPU, loaded.backend)
        assertEquals(1, gpu.closed)
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)
        assertTrue(loaded.skipped.single().contains("wrong numbers"))
    }

    @Test
    fun aBlockedGpuIsSkippedWithoutBeingOpened() {
        health.strike(EmbedBackend.GPU, "x")
        health.strike(EmbedBackend.GPU, "y")
        val factory = FakeEngineFactory { FakeEngine { FloatArray(4) } }
        val loaded = ladder.load(
            model = "m",
            candidates = order,
            open = { b -> factory.open(b) },
            prove = { _, _ -> },
            close = { },
        )
        assertEquals(EmbedBackend.CPU, loaded.backend)
        assertEquals("the blocked GPU is not even tried", listOf(EmbedBackend.CPU), factory.opened)
        assertTrue(loaded.skipped.single().contains("blocked"))
    }

    @Test
    fun theCpuIsTriedEvenAfterManyStrikes() {
        repeat(5) { health.strike(EmbedBackend.CPU, "memory kill") }
        val factory = FakeEngineFactory { FakeEngine { FloatArray(4) } }
        val loaded = ladder.load("m", listOf(EmbedBackend.CPU), { b -> factory.open(b) }, { _, _ -> }, { })
        assertEquals(EmbedBackend.CPU, loaded.backend)
        assertEquals(listOf(EmbedBackend.CPU), factory.opened)
    }

    @Test
    fun whenEveryCandidateFailsTheErrorNamesThemAll() {
        val failure = runCatching {
            ladder.load(
                model = "m",
                candidates = order,
                open = { throw IllegalStateException("cannot load ${it.id}") },
                prove = { _, _ -> },
                close = { },
            )
        }.exceptionOrNull()
        assertTrue("expected NoBackendException, got $failure", failure is NoBackendException)
        val noBackend = failure as NoBackendException
        assertEquals(listOf("gpu", "cpu"), noBackend.candidates)
        assertEquals(2, noBackend.reasons.size)
        assertTrue(noBackend.reasons[0].contains("gpu"))
        assertTrue(noBackend.reasons[1].contains("cpu"))
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)
        assertEquals(1, health.record(EmbedBackend.CPU)!!.strikes)
    }

    @Test
    fun aProvenBackendIsRecordedEvenIfItHadStrikesBefore() {
        health.strike(EmbedBackend.GPU, "one bad day")
        val loaded = ladder.load("m", listOf(EmbedBackend.GPU), { FakeEngine { FloatArray(4) } }, { _, _ -> }, { })
        assertEquals(EmbedBackend.GPU, loaded.backend)
        val record = health.record(EmbedBackend.GPU)!!
        assertTrue(record.everProven)
        assertFalse(record.blocked)
        assertEquals(1, record.strikes)
    }

    @Test
    fun duplicatesInTheCandidateListAreIgnored() {
        val factory = FakeEngineFactory { FakeEngine { FloatArray(4) } }
        ladder.load("m", listOf(EmbedBackend.CPU, EmbedBackend.CPU), { factory.open(it) }, { _, _ -> }, { })
        assertEquals(listOf(EmbedBackend.CPU), factory.opened)
    }

    @Test
    fun anEmptyCandidateListIsAProgrammingError() {
        assertTrue(runCatching { ladder.load<Any>("m", emptyList(), { error("no") }, { _, _ -> }, { }) }
            .exceptionOrNull() is IllegalArgumentException)
    }
}
