package dev.hajnina.scanlist.kotlin.ui

import dev.hajnina.scanlist.kotlin.scan.sources.Luma
import dev.hajnina.scanlist.kotlin.scan.sources.Yuv420Frame
import dev.hajnina.scanlist.kotlin.scan.sources.yuv420Constant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B7 — the low-light state, tested as math: no camera, no Android, fake frames only.
 *
 * [Luma.mean] must honour Y plane strides exactly like `Nv21.fromYuv420` does (padding must not be
 * averaged in, or a padded frame reads darker than it is), and [LowLightDetector] must not flip on a
 * single frame in either direction.
 */
class LowLightTest {

    // ------------------------------------------------------------------ Luma.mean

    @Test
    fun `mean luma of a constant frame is the constant`() {
        assertEquals(128.0, Luma.mean(yuv420Constant(64, 48, y = 128), step = 8), 1e-9)
        assertEquals(17.0, Luma.mean(yuv420Constant(64, 48, y = 17), step = 1), 1e-9)
    }

    @Test
    fun `mean luma ignores chroma and row padding`() {
        // 8x4 luma with a row stride of 16: the second half of each row is padding that must never be
        // read (it is often stale/zero memory from CameraX and would drag the mean down).
        val width = 8
        val height = 4
        val rowStride = 16
        val y = ByteArray(rowStride * height) { 0 }
        for (row in 0 until height) {
            for (col in 0 until width) y[row * rowStride + col] = 200.toByte()
        }
        val frame = Yuv420Frame(
            width = width,
            height = height,
            y = y,
            yRowStride = rowStride,
            yPixelStride = 1,
            u = ByteArray(4 * 2) { 0 },
            uRowStride = 4,
            uPixelStride = 1,
            v = ByteArray(4 * 2) { 0 },
            vRowStride = 4,
            vPixelStride = 1,
        )
        assertEquals(200.0, Luma.mean(frame, step = 1), 1e-9)
    }

    @Test
    fun `mean luma honours a pixel stride of two`() {
        // Semi-planar Y with pixelStride 2 (as some devices hand over): every other byte is the sample,
        // the interleaved byte is garbage (0) and must not count.
        val width = 8
        val height = 4
        val rowStride = width * 2
        val y = ByteArray(rowStride * height) { 0 }
        for (row in 0 until height) {
            for (col in 0 until width) y[row * rowStride + col * 2] = 100.toByte()
        }
        val frame = Yuv420Frame(
            width = width,
            height = height,
            y = y,
            yRowStride = rowStride,
            yPixelStride = 2,
            u = ByteArray(4 * 2) { 0 },
            uRowStride = 4,
            uPixelStride = 1,
            v = ByteArray(4 * 2) { 0 },
            vRowStride = 4,
            vPixelStride = 1,
        )
        assertEquals(100.0, Luma.mean(frame, step = 1), 1e-9)
    }

    @Test
    fun `full-range bytes are read unsigned`() {
        // 0xFF is -1 as a Kotlin Byte: an unsigned read is the whole difference between "bright" and
        // "black", and this is the classic bug in hand-rolled luma code.
        assertEquals(255.0, Luma.mean(yuv420Constant(32, 32, y = 255), step = 4), 1e-9)
    }

    @Test
    fun `sampling step does not change a uniform frame`() {
        val frame = yuv420Constant(80, 60, y = 77)
        val one = Luma.mean(frame, step = 1)
        val eight = Luma.mean(frame, step = 8)
        assertEquals(one, eight, 1e-9)
    }

    @Test
    fun `a non-uniform frame is the average of its samples`() {
        // Left half 20, right half 220 → 120 for any symmetric sample grid.
        val width = 64
        val height = 16
        val y = ByteArray(width * height) { i ->
            val col = i % width
            (if (col < width / 2) 20 else 220).toByte()
        }
        val frame = Yuv420Frame(
            width = width,
            height = height,
            y = y,
            yRowStride = width,
            yPixelStride = 1,
            u = ByteArray(width * height / 4) { 0 },
            uRowStride = width / 2,
            uPixelStride = 1,
            v = ByteArray(width * height / 4) { 0 },
            vRowStride = width / 2,
            vPixelStride = 1,
        )
        assertEquals(120.0, Luma.mean(frame, step = 8), 1e-9)
    }

    // ------------------------------------------------------------------ LowLightDetector

    @Test
    fun `starts unknown and stays quiet without frames`() {
        val detector = LowLightDetector()
        assertEquals(LowLightState.UNKNOWN, detector.state)
    }

    @Test
    fun `needs a sustained dark run before calling a room dim`() {
        val detector = LowLightDetector(framesToEnter = 3)
        assertEquals(LowLightState.UNKNOWN, detector.sample(10.0))
        assertEquals(LowLightState.UNKNOWN, detector.sample(10.0))
        assertEquals(LowLightState.DIM, detector.sample(10.0))
    }

    @Test
    fun `one dark frame between bright ones does not flip the state`() {
        val detector = LowLightDetector(framesToEnter = 3, framesToExit = 3)
        repeat(3) { detector.sample(200.0) }
        assertEquals(LowLightState.OK, detector.state)
        detector.sample(5.0) // a hand/phone shadow across the lens
        assertEquals(LowLightState.OK, detector.state)
        repeat(3) { detector.sample(200.0) }
        assertEquals(LowLightState.OK, detector.state)
    }

    @Test
    fun `exiting dim needs more bright frames than entering it`() {
        val detector = LowLightDetector(framesToEnter = 2, framesToExit = 4)
        repeat(2) { detector.sample(10.0) }
        assertEquals(LowLightState.DIM, detector.state)
        repeat(3) { detector.sample(200.0) }
        assertEquals(LowLightState.DIM, detector.state)
        detector.sample(200.0)
        assertEquals(LowLightState.OK, detector.state)
    }

    @Test
    fun `a dark run interrupted by the dead band never accumulates`() {
        val detector = LowLightDetector(enterBelow = 40.0, exitAbove = 60.0, framesToEnter = 3)
        detector.sample(10.0)
        detector.sample(10.0)
        detector.sample(50.0) // dead band: neither dark nor bright evidence
        detector.sample(10.0)
        detector.sample(10.0)
        assertEquals(LowLightState.UNKNOWN, detector.state)
        detector.sample(10.0)
        assertEquals(LowLightState.DIM, detector.state)
    }

    @Test
    fun `dead band alone never produces a state`() {
        val detector = LowLightDetector()
        repeat(50) { detector.sample(50.0) }
        assertEquals(LowLightState.UNKNOWN, detector.state)
    }

    @Test
    fun `non-finite luma is ignored`() {
        val detector = LowLightDetector(framesToEnter = 1)
        assertEquals(LowLightState.UNKNOWN, detector.sample(Double.NaN))
        assertEquals(LowLightState.UNKNOWN, detector.sample(Double.POSITIVE_INFINITY))
        assertEquals(LowLightState.UNKNOWN, detector.state)
    }

    @Test
    fun `dim and ok both return to the opposite state`() {
        val detector = LowLightDetector(framesToEnter = 1, framesToExit = 1)
        assertEquals(LowLightState.DIM, detector.sample(1.0))
        assertEquals(LowLightState.OK, detector.sample(254.0))
        assertEquals(LowLightState.DIM, detector.sample(1.0))
    }

    @Test
    fun `reset forgets the current room`() {
        val detector = LowLightDetector(framesToEnter = 2, framesToExit = 2)
        repeat(2) { detector.sample(5.0) }
        assertEquals(LowLightState.DIM, detector.state)
        detector.reset()
        assertEquals(LowLightState.UNKNOWN, detector.state)
        // A single bright frame after reset must not be enough to claim OK.
        assertEquals(LowLightState.UNKNOWN, detector.sample(240.0))
    }

    @Test
    fun `thresholds must be ordered`() {
        val error = runCatching { LowLightDetector(enterBelow = 60.0, exitAbove = 40.0) }
        assertTrue(error.exceptionOrNull() is IllegalArgumentException)
    }
}
