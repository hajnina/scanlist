package dev.hajnina.scanlist.kotlin.scan.sources

/** Pixel size of a frame; YUV_420_888 requires even dimensions, so every produced size is even. */
data class FrameSize(val width: Int, val height: Int) {
    init {
        require(width > 0 && height > 0) { "size must be positive, was ${width}x$height" }
    }

    val shortSide: Int get() = minOf(width, height)
    val longSide: Int get() = maxOf(width, height)
}

/**
 * Downscale math for the image-embedding frames (card B4: "JPEG frame sampler, 384 px short side").
 *
 * Pure arithmetic (aspect-preserving, box-scale friendly), unit-tested with fake sizes. The
 * EmbeddingGemma on-device bundle is provisioned for 70/140 vision tokens
 * (docs/ARCHITECTURE.md), so a 384 px short side is plenty and keeps JPEG encode + upload cheap.
 */
object FrameGeometry {

    /** Short side of the frames handed to the image embedder. */
    const val EMBED_SHORT_SIDE = 384

    /**
     * Target size for a [width] x [height] camera frame: short side = [shortSide] (384 by default),
     * long side scaled to keep the aspect ratio, both rounded UP to even numbers.
     *
     * Never upscales: a frame whose short side is already <= [shortSide] is returned (even-rounded),
     * because inventing pixels would only cost time. The even rounding can shave at most one pixel.
     */
    fun targetSize(
        width: Int,
        height: Int,
        shortSide: Int = EMBED_SHORT_SIDE,
    ): FrameSize {
        require(width > 0 && height > 0) { "frame must be positive, was ${width}x$height" }
        require(shortSide > 1) { "shortSide must be > 1, was $shortSide" }

        val sourceShort = minOf(width, height)
        if (sourceShort <= shortSide) return FrameSize(evenDown(width), evenDown(height))

        val targetShort = evenDown(shortSide)
        val scale = targetShort.toDouble() / sourceShort
        val long = maxOf(width, height)
        val targetLong = evenUp((long * scale).toInt())

        return if (width <= height) {
            FrameSize(targetShort, maxOf(targetLong, targetShort))
        } else {
            FrameSize(maxOf(targetLong, targetShort), targetShort)
        }
    }

    /** Largest even value <= [v] (at least 2): rounding down cannot overflow the source. */
    internal fun evenDown(v: Int): Int = maxOf(2, v - (v and 1))

    /** Smallest even value >= [v] (at least 2). */
    internal fun evenUp(v: Int): Int = maxOf(2, if (v and 1 == 0) v else v + 1)
}
