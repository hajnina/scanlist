package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** Card B4: 384 px short side, aspect preserved, even dimensions (YUV/NV21 requirement). */
class FrameGeometryTest {

    @Test
    fun `portrait 1080x1920 becomes 384x682`() {
        assertEquals(FrameSize(384, 682), FrameGeometry.targetSize(1080, 1920))
    }

    @Test
    fun `landscape 1920x1080 becomes 682x384`() {
        assertEquals(FrameSize(682, 384), FrameGeometry.targetSize(1920, 1080))
    }

    @Test
    fun `720p becomes 384x682 and 4 by 3 becomes 512x384`() {
        assertEquals(FrameSize(384, 682), FrameGeometry.targetSize(720, 1280))
        assertEquals(FrameSize(512, 384), FrameGeometry.targetSize(4032, 3024))
    }

    @Test
    fun `short side is exactly the requested value`() {
        listOf(1080 to 1920, 1280 to 720, 3024 to 4032, 1000 to 1000).forEach { (w, h) ->
            val size = FrameGeometry.targetSize(w, h)
            assertEquals("short side for ${w}x$h", 384, size.shortSide)
        }
    }

    @Test
    fun `aspect ratio survives scaling within one pixel`() {
        listOf(1080 to 1920, 4032 to 3024, 1600 to 1200, 640 to 480).forEach { (w, h) ->
            val size = FrameGeometry.targetSize(w, h)
            val sourceRatio = w.toDouble() / h
            val targetRatio = size.width.toDouble() / size.height
            assertTrue(
                "ratio for ${w}x$h -> ${size.width}x${size.height}",
                abs(sourceRatio - targetRatio) < 0.01,
            )
        }
    }

    @Test
    fun `never upscales a frame that is already small`() {
        assertEquals(FrameSize(320, 240), FrameGeometry.targetSize(320, 240))
    }

    @Test
    fun `odd dimensions are even-rounded`() {
        assertEquals(FrameSize(400, 300), FrameGeometry.targetSize(401, 301))
    }

    @Test
    fun `all produced dimensions are even`() {
        listOf(1081 to 1921, 999 to 1501, 384 to 385).forEach { (w, h) ->
            val size = FrameGeometry.targetSize(w, h)
            assertEquals("width even for ${w}x$h", 0, size.width % 2)
            assertEquals("height even for ${w}x$h", 0, size.height % 2)
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `zero size is rejected`() {
        FrameGeometry.targetSize(0, 720)
    }
}
