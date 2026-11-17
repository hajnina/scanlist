package dev.hajnina.scanlist.kotlin.scan.sources

/** Test-only clock: tests move time by hand so every window/gate decision is deterministic. */
class FakeClock(private var now: Long = 0L) : Clock {
    override fun nowMs(): Long = now
    fun advance(deltaMs: Long): Long {
        now += deltaMs
        return now
    }
}

/** Builds a synthetic packed NV21 buffer: constant Y, U, V everywhere. */
fun nv21Constant(width: Int, height: Int, y: Int = 128, u: Int = 64, v: Int = 192): ByteArray {
    val out = ByteArray(width * height + 2 * (width / 2) * (height / 2))
    for (i in 0 until width * height) out[i] = y.toByte()
    var o = width * height
    repeat((width / 2) * (height / 2)) {
        out[o++] = v.toByte()
        out[o++] = u.toByte()
    }
    return out
}

/**
 * Synthetic YUV_420_888 frame with planar planes (pixelStride 1) and no row padding — the simple
 * case of the fake frames the card asks for. Stride handling itself is covered by Yuv420Test.
 */
fun yuv420Constant(
    width: Int,
    height: Int,
    y: Int = 128,
    u: Int = 64,
    v: Int = 192,
): Yuv420Frame {
    val cw = width / 2
    val ch = height / 2
    return Yuv420Frame(
        width = width,
        height = height,
        y = ByteArray(width * height) { y.toByte() },
        yRowStride = width,
        yPixelStride = 1,
        u = ByteArray(cw * ch) { u.toByte() },
        uRowStride = cw,
        uPixelStride = 1,
        v = ByteArray(cw * ch) { v.toByte() },
        vRowStride = cw,
        vPixelStride = 1,
    )
}

/** Records what the core asked the encoder to do, so tests can assert the 384 px downscale. */
class RecordingJpegEncoder(private val result: ByteArray? = byteArrayOf(0xFF.toByte(), 0xD8.toByte())) : JpegEncoder {
    data class Call(val nv21Size: Int, val width: Int, val height: Int, val quality: Int)

    val calls = mutableListOf<Call>()
    val last: Call? get() = calls.lastOrNull()

    override fun encode(nv21: ByteArray, width: Int, height: Int, quality: Int): ByteArray? {
        calls += Call(nv21.size, width, height, quality)
        return result
    }
}
