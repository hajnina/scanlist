package dev.hajnina.scanlist.kotlin.scan.sources

/** One decoded barcode, detached from ML Kit so the decision logic can be unit-tested. */
data class BarcodeHit(
    val value: String,
    /** ML Kit format name, diagnostics only ("EAN_13", "QR_CODE", ...). */
    val format: String = "UNKNOWN",
)

/**
 * JPEG encoder seam: the pure part produces NV21 + a target size, this turns it into bytes.
 * The Android implementation is [AndroidJpegEncoder] (`YuvImage.compressToJpeg`); tests pass a fake
 * that records what it was given and returns marker bytes, so no Android graphics are needed.
 */
fun interface JpegEncoder {
    fun encode(nv21: ByteArray, width: Int, height: Int, quality: Int): ByteArray?

    companion object {
        /** No-op encoder: [ScanFrameCore.onFrame] then emits nothing (used by non-image consumers). */
        val None: JpegEncoder = JpegEncoder { _, _, _, _ -> null }
    }
}

/**
 * All the decisions of the camera scan source in one pure class (card B4).
 *
 * The CameraX/ML Kit glue (CameraScanAnalyzer.kt) only copies planes, calls the two ML Kit clients
 * and forwards the results here. Everything that can be wrong — fps gate, 384 px scaling, YUV→NV21,
 * barcode dedupe, OCR batching, signal shape — is in this class and unit-tested with fake frames
 * and a fake clock. Methods take `nowMs` explicitly (defaulting to the injected clock) so tests can
 * drive a synthetic timeline.
 *
 * Not thread-safe: CameraX calls it from one analysis executor.
 */
class ScanFrameCore(
    private val clock: Clock = Clock.Default,
    private val sampler: FrameSampler = FrameSampler(clock),
    private val barcodeDeduplicator: BarcodeDeduplicator = BarcodeDeduplicator(clock),
    private val ocrBatcher: OcrLineBatcher = OcrLineBatcher(),
    private val jpegEncoder: JpegEncoder = JpegEncoder.None,
    private val shortSide: Int = FrameGeometry.EMBED_SHORT_SIDE,
    private val jpegQuality: Int = DEFAULT_JPEG_QUALITY,
) {

    /** Barcode signals for this frame, already deduped; usually empty. */
    fun onBarcodeHits(hits: List<BarcodeHit>, nowMs: Long = clock.nowMs()): List<ScanSignal> =
        hits.mapNotNull { hit ->
            if (!barcodeDeduplicator.accept(hit.value, nowMs)) return@mapNotNull null
            ScanSignal.barcode(hit.value.trim(), nowMs)
        }

    /** One batched TEXT signal for this frame, or null when the OCR lines add nothing new. */
    fun onOcrLines(lines: List<String>, nowMs: Long = clock.nowMs()): ScanSignal? =
        ocrBatcher.batch(lines, nowMs)?.let { ScanSignal.text(it, nowMs) }

    /**
     * One IMAGE signal for this frame, or null when the ≤ 2.5 fps gate says skip (or the encoder
     * fails). The frame is box-scaled to a 384 px short side *before* JPEG encoding, so the encoder
     * and the embedder only ever see a small buffer.
     *
     * This overload takes an already-materialised frame; the [frame] provider overload exists so the
     * Android glue can avoid copying ~1.4 MB of planes on the 27 frames/s the gate drops.
     */
    fun onFrame(frame: Yuv420Frame, nowMs: Long = clock.nowMs()): ScanSignal? = onFrame(nowMs) { frame }

    /** Gate first, then materialise the frame only if this frame is due. */
    fun onFrame(nowMs: Long, frame: () -> Yuv420Frame?): ScanSignal? {
        if (!sampler.shouldEmit(nowMs)) return null
        val source = frame() ?: return null

        val target = FrameGeometry.targetSize(source.width, source.height, shortSide)
        val nv21 = Nv21.fromYuv420(source)
        val scaled = if (target == source.size) nv21 else Nv21.scale(nv21, source.size, target)
        val jpeg = jpegEncoder.encode(scaled, target.width, target.height, jpegQuality) ?: return null
        return ScanSignal.image(jpeg, nowMs)
    }

    /** Target size the next frame will be encoded at (B5 shows this in a debug chip if it wants). */
    fun targetSizeFor(width: Int, height: Int): FrameSize =
        FrameGeometry.targetSize(width, height, shortSide)

    fun reset() {
        sampler.reset()
        barcodeDeduplicator.reset()
        ocrBatcher.reset()
    }

    companion object {
        /** Visually lossless enough for an embedding, and small: 384 px JPEG ≈ 20–40 kB. */
        const val DEFAULT_JPEG_QUALITY = 80
    }
}
