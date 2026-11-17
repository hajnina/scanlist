package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * One YUV_420_888 camera frame with its real plane strides, as CameraX hands it over.
 *
 * Pure data + arithmetic: no Android imports, so the conversion to NV21 and the 384 px box-scale
 * are JVM-unit-testable with synthetic frames. The Android glue (CameraScanAnalyzer.kt) copies the
 * `ImageProxy` planes into this shape; everything after that is this file.
 *
 * YUV_420_888 is *not* a fixed layout: every plane has its own row stride (padding) and pixel
 * stride (1 = planar, 2 = semi-planar/interleaved). Ignoring strides is the classic green-image
 * bug, so they are carried explicitly and honoured in [Nv21.fromYuv420].
 */
class Yuv420Frame(
    val width: Int,
    val height: Int,
    val y: ByteArray,
    val yRowStride: Int,
    val yPixelStride: Int = 1,
    val u: ByteArray,
    val uRowStride: Int,
    val uPixelStride: Int = 1,
    val v: ByteArray,
    val vRowStride: Int,
    val vPixelStride: Int = 1,
) {
    init {
        require(width > 1 && height > 1) { "frame must be at least 2x2, was ${width}x$height" }
        require(width % 2 == 0 && height % 2 == 0) {
            "YUV_420_888 frame must have even dimensions, was ${width}x$height"
        }
        require(yRowStride >= width) { "yRowStride $yRowStride < width $width" }
        require(uRowStride > 0 && vRowStride > 0)
        require(yPixelStride >= 1 && uPixelStride >= 1 && vPixelStride >= 1)
        require(y.size >= (height - 1) * yRowStride + (width - 1) * yPixelStride + 1) {
            "Y plane too small for ${width}x$height @ rowStride=$yRowStride pixelStride=$yPixelStride"
        }
    }

    val size: FrameSize get() = FrameSize(width, height)
}

/**
 * Luma (brightness) of the Y plane, full range 0..255.
 *
 * Card B7's low-light gate needs one number per analysed frame. It lives here, next to the other pure
 * YUV arithmetic, so the stride/pixel-stride rules are shared with [Nv21]: padding bytes must never be
 * averaged into the mean (CameraX leaves them stale) and a `pixelStride` of 2 means every other byte is
 * the sample. The detector that debounces this stream is `ui/LowLightDetector`.
 */
object Luma {

    /**
     * Mean luma of [frame], sampling every [step]-th pixel row and column. A 720p frame is ~920k
     * pixels; step 8 reads ~14k of them, which is exact enough for a light-level gate and cheap
     * enough to run on the camera analysis thread.
     */
    fun mean(frame: Yuv420Frame, step: Int = 8): Double {
        require(step >= 1) { "step must be >= 1, was $step" }
        val width = frame.width
        val height = frame.height
        var sum = 0L
        var count = 0
        var y = 0
        while (y < height) {
            var x = 0
            var i = y * frame.yRowStride
            while (x < width) {
                sum += frame.y[i].toInt() and 0xFF
                count++
                x += step
                i += step * frame.yPixelStride
            }
            y += step
        }
        return if (count == 0) 0.0 else sum.toDouble() / count
    }
}

/**
 * NV21 (a.k.a. YUV420sp) helpers: the layout `android.graphics.YuvImage` accepts, so the last step
 * of "frame → JPEG" is a single `YuvImage.compressToJpeg` call on the already-downscaled buffer.
 *
 * NV21 = full Y plane (width*height bytes, no padding) followed by interleaved **V then U** for the
 * (width/2)x(height/2) chroma grid. Both dimensions are even (enforced by [Yuv420Frame] and
 * [FrameGeometry]), which YuvImage requires.
 */
object Nv21 {

    /** Flatten a strided YUV_420_888 frame into packed NV21, honouring every plane stride. */
    fun fromYuv420(frame: Yuv420Frame): ByteArray {
        val width = frame.width
        val height = frame.height
        val out = ByteArray(width * height + 2 * (width / 2) * (height / 2))

        var o = 0
        for (row in 0 until height) {
            var i = row * frame.yRowStride
            repeat(width) {
                out[o++] = frame.y[i]
                i += frame.yPixelStride
            }
        }

        val chromaWidth = width / 2
        val chromaHeight = height / 2
        for (row in 0 until chromaHeight) {
            var vi = row * frame.vRowStride
            var ui = row * frame.uRowStride
            repeat(chromaWidth) {
                out[o++] = frame.v[vi]
                out[o++] = frame.u[ui]
                vi += frame.vPixelStride
                ui += frame.uPixelStride
            }
        }
        return out
    }

    /**
     * Box-average downscale of a packed NV21 buffer to [target] (aspect already handled by
     * [FrameGeometry.targetSize]).
     *
     * Box averaging (each destination pixel = mean of the source pixels it covers) instead of
     * nearest-neighbour: 1080 → 384 is a ~2.8x reduction, and dropping 7 of every 8 pixels makes
     * OCR-like texture unreadable, which would hurt the image embedding. It is still pure integer
     * arithmetic and unit-tested (a constant frame must stay constant).
     */
    fun scale(source: ByteArray, sourceSize: FrameSize, target: FrameSize): ByteArray {
        require(target.width % 2 == 0 && target.height % 2 == 0) {
            "NV21 target must be even, was ${target.width}x${target.height}"
        }
        val sw = sourceSize.width
        val sh = sourceSize.height
        require(source.size >= sw * sh + 2 * (sw / 2) * (sh / 2)) {
            "source buffer too small for ${sw}x$sh"
        }

        val out = ByteArray(target.width * target.height + 2 * (target.width / 2) * (target.height / 2))

        // Y: one destination pixel per box.
        for (dy in 0 until target.height) {
            val y0 = dy * sh / target.height
            val y1 = maxOf(y0 + 1, (dy + 1) * sh / target.height)
            for (dx in 0 until target.width) {
                val x0 = dx * sw / target.width
                val x1 = maxOf(x0 + 1, (dx + 1) * sw / target.width)
                out[dy * target.width + dx] = boxMean(source, sw, x0, y0, x1, y1)
            }
        }

        // Chroma: boxes in chroma-grid space, then interleave V,U like NV21.
        val srcChromaW = sw / 2
        val srcChromaH = sh / 2
        val dstChromaW = target.width / 2
        val dstChromaH = target.height / 2
        val chromaBase = sw * sh
        val chromaRowStride = srcChromaW * 2
        var o = target.width * target.height
        for (dy in 0 until dstChromaH) {
            val y0 = dy * srcChromaH / dstChromaH
            val y1 = maxOf(y0 + 1, (dy + 1) * srcChromaH / dstChromaH)
            for (dx in 0 until dstChromaW) {
                val x0 = dx * srcChromaW / dstChromaW
                val x1 = maxOf(x0 + 1, (dx + 1) * srcChromaW / dstChromaW)
                out[o++] = boxMean(source, chromaRowStride, x0, y0, x1, y1, chromaBase, step = 2, offset = 0)
                out[o++] = boxMean(source, chromaRowStride, x0, y0, x1, y1, chromaBase, step = 2, offset = 1)
            }
        }
        return out
    }

    private fun boxMean(
        data: ByteArray,
        stride: Int,
        x0: Int,
        y0: Int,
        x1: Int,
        y1: Int,
        base: Int = 0,
        step: Int = 1,
        offset: Int = 0,
    ): Byte {
        var sum = 0
        var count = 0
        for (y in y0 until y1) {
            val row = base + y * stride + offset
            for (x in x0 until x1) {
                sum += data[row + x * step].toInt() and 0xFF
                count++
            }
        }
        return (sum / maxOf(1, count)).toByte()
    }
}
