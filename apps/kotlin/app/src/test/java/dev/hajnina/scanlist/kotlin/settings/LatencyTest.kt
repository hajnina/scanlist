package dev.hajnina.scanlist.kotlin.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Card B6 "live embed latency": the numbers the card shows are the tested formatting, not ad-hoc strings. */
class LatencyTest {

    @Test
    fun `per-call millis below a second, seconds from a second up`() {
        assertEquals("0 ms", LatencyFormat.millis(0))
        assertEquals("35 ms", LatencyFormat.millis(35))
        assertEquals("999 ms", LatencyFormat.millis(999))
        assertEquals("1.00 s", LatencyFormat.millis(1000))
        assertEquals("3.81 s", LatencyFormat.millis(3810))
    }

    @Test
    fun `means keep one decimal in milliseconds and two in seconds`() {
        assertEquals("35.2 ms", LatencyFormat.mean(35.24))
        assertEquals("72.0 ms", LatencyFormat.mean(72.0))
        assertEquals("1.23 s", LatencyFormat.mean(1234.5))
    }

    @Test
    fun `report computes mean fastest slowest and a readable headline`() {
        val report = LatencyReport(
            backend = "gpu",
            samples = listOf(
                LatencySample("a", 30),
                LatencySample("b", 40),
                LatencySample("c", 50),
            ),
            loadMillis = 3810,
            supportsImages = true,
        )
        assertEquals(40.0, report.meanMillis, 0.0001)
        assertEquals(30L, report.fastestMillis)
        assertEquals(50L, report.slowestMillis)
        assertEquals("gpu · mean 40.0 ms · 3 calls", report.headline())
    }

    @Test
    fun `an empty report has no mean and no extremes`() {
        val report = LatencyReport(backend = "cpu", samples = emptyList())
        assertEquals(0.0, report.meanMillis, 0.0)
        assertNull(report.fastestMillis)
        assertNull(report.slowestMillis)
        assertEquals("cpu · mean 0.0 ms · 0 calls", report.headline())
    }
}
