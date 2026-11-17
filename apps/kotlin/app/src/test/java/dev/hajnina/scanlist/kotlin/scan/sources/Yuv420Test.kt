package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Card B4: YUV_420_888 (strided) -> packed NV21, and the 384 px box-scale, both pure. */
class Yuv420Test {

    @Test
    fun `planar 2x2 frame becomes packed NV21 with V before U`() {
        val frame = Yuv420Frame(
            width = 2,
            height = 2,
            y = byteArrayOf(10, 20, 30, 40),
            yRowStride = 2,
            u = byteArrayOf(100),
            uRowStride = 1,
            v = byteArrayOf(200.toByte()),
            vRowStride = 1,
        )

        // NV21 = Y plane, then interleaved V,U for the single chroma sample.
        assertArrayEquals(
            byteArrayOf(10, 20, 30, 40, 200.toByte(), 100),
            Nv21.fromYuv420(frame),
        )
    }

    @Test
    fun `row padding and semi-planar pixel stride are honoured`() {
        // 4x2 frame: Y rows padded to 6 bytes, chroma rows padded to 4 bytes with pixelStride 2.
        val frame = Yuv420Frame(
            width = 4,
            height = 2,
            y = byteArrayOf(1, 2, 3, 4, 99, 99, 5, 6, 7, 8, 99, 99),
            yRowStride = 6,
            yPixelStride = 1,
            u = byteArrayOf(7, 99, 8, 99),
            uRowStride = 4,
            uPixelStride = 2,
            v = byteArrayOf(9, 99, 10, 99),
            vRowStride = 4,
            vPixelStride = 2,
        )

        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 7, 10, 8),
            Nv21.fromYuv420(frame),
        )
    }

    @Test
    fun `box scale keeps a constant frame constant`() {
        val source = nv21Constant(width = 4, height = 4, y = 128, u = 64, v = 192)
        val scaled = Nv21.scale(source, FrameSize(4, 4), FrameSize(2, 2))

        assertEquals(2 * 2 + 2 * 1 * 1, scaled.size)
        assertArrayEquals(
            byteArrayOf(128.toByte(), 128.toByte(), 128.toByte(), 128.toByte()),
            scaled.copyOfRange(0, 4),
        )
        assertEquals(192.toByte(), scaled[4]) // V
        assertEquals(64.toByte(), scaled[5]) // U
    }

    @Test
    fun `box scale averages each source block`() {
        // 4x4 Y: rows 0-1 = 10, rows 2-3 = 20; chroma constant.
        val source = ByteArray(16 + 2 * 2 * 2)
        for (y in 0 until 4) for (x in 0 until 4) source[y * 4 + x] = if (y < 2) 10 else 20
        for (i in 16 until source.size) source[i] = 100

        val scaled = Nv21.scale(source, FrameSize(4, 4), FrameSize(2, 2))
        assertArrayEquals(byteArrayOf(10, 10, 20, 20), scaled.copyOfRange(0, 4))
    }

    @Test
    fun `scaled buffer has the NV21 size for the target`() {
        val source = nv21Constant(width = 1080, height = 1920)
        val target = FrameGeometry.targetSize(1080, 1920)
        val scaled = Nv21.scale(source, FrameSize(1080, 1920), target)

        assertEquals(target.width * target.height + 2 * (target.width / 2) * (target.height / 2), scaled.size)
        assertTrue("scaled frame must be far smaller than the source", scaled.size < source.size / 4)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `odd target size is rejected by the scaler`() {
        Nv21.scale(nv21Constant(4, 4), FrameSize(4, 4), FrameSize(3, 3))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `odd frame dimensions are rejected`() {
        Yuv420Frame(
            width = 3,
            height = 2,
            y = ByteArray(6),
            yRowStride = 3,
            u = ByteArray(1),
            uRowStride = 1,
            v = ByteArray(1),
            vRowStride = 1,
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `undersized Y plane is rejected`() {
        Yuv420Frame(
            width = 4,
            height = 4,
            y = ByteArray(4),
            yRowStride = 4,
            u = ByteArray(4),
            uRowStride = 2,
            v = ByteArray(4),
            vRowStride = 2,
        )
    }
}
