package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Card B4 Done-when: the ≤ 2.5 fps image gate, driven by a fake clock. */
class FrameSamplerTest {

    @Test
    fun `three frames inside 200 ms emit only once`() {
        val clock = FakeClock()
        val sampler = FrameSampler(clock)

        assertTrue("first frame must always pass", sampler.shouldEmit())
        clock.advance(100)
        assertFalse(sampler.shouldEmit())
        clock.advance(100)
        assertFalse(sampler.shouldEmit())
    }

    @Test
    fun `emits again at exactly the 400 ms interval`() {
        val clock = FakeClock()
        val sampler = FrameSampler(clock)

        assertTrue(sampler.shouldEmit())
        clock.advance(399)
        assertFalse(sampler.shouldEmit())
        clock.advance(1)
        assertTrue(sampler.shouldEmit())
    }

    @Test
    fun `a full second of 30 fps frames yields at most 2_5 fps`() {
        val clock = FakeClock()
        val sampler = FrameSampler(clock)
        var emitted = 0

        // 30 frames at ~33 ms = one second of camera output.
        repeat(30) {
            if (sampler.shouldEmit()) emitted++
            clock.advance(33)
        }
        assertEquals(3, emitted) // t=0, 429 ms, 858 ms
        assertTrue("must not exceed 2.5 fps", emitted <= 3)
    }

    @Test
    fun `reset lets the next frame through immediately`() {
        val clock = FakeClock()
        val sampler = FrameSampler(clock)
        assertTrue(sampler.shouldEmit())
        clock.advance(10)
        assertFalse(sampler.shouldEmit())
        sampler.reset()
        assertTrue(sampler.shouldEmit())
    }

    @Test
    fun `default interval is derived from 2_5 fps`() {
        assertEquals(400L, FrameSampler.DEFAULT_MIN_INTERVAL_MS)
        assertEquals(2.5, FrameSampler.TARGET_FPS, 0.0)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `non-positive interval is rejected`() {
        FrameSampler(minIntervalMs = 0)
    }
}
