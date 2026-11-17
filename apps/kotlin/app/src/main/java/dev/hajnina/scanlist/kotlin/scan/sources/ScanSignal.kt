package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * One observation from one scan source (card B4).
 *
 * Sources are pluggable and run in parallel (docs/ARCHITECTURE.md, "Shared pipeline"):
 * a barcode decode, some visible OCR words, or a JPEG frame for the image embedder. The scan screen
 * (card B5) consumes this type and turns text into query vectors / the frame into an image vector;
 * nothing here knows about embedding, ranking or Compose.
 *
 * `confidence` is 0..1. Honest caveat: neither ML Kit's bundled barcode scanner nor its text
 * recogniser exposes a per-result confidence, so the Android glue fills in the source constants
 * below (a decoded barcode is exact; OCR words are a hint). The field is part of the contract so a
 * later source (e.g. a detector that does report scores) can fill it without changing consumers.
 */
enum class ScanKind { BARCODE, TEXT, IMAGE }

/** Either OCR/barcode text or a JPEG frame — exactly one of the two, chosen by [ScanSignal.kind]. */
sealed interface ScanPayload {
    data class Text(val value: String) : ScanPayload

    /**
     * JPEG bytes for the image embedder. A plain class (not a data class) because [bytes] is the
     * payload: equality is by content, and toString must not dump a megabyte of numbers.
     */
    class Jpeg(val bytes: ByteArray) : ScanPayload {
        override fun equals(other: Any?): Boolean =
            this === other || (other is Jpeg && bytes.contentEquals(other.bytes))

        override fun hashCode(): Int = bytes.contentHashCode()

        override fun toString(): String = "Jpeg(${bytes.size} B)"
    }
}

/** A signal as emitted by the sources; immutable, safe to hand to another thread. */
data class ScanSignal(
    val kind: ScanKind,
    val payload: ScanPayload,
    val confidence: Float,
    /** Monotonic milliseconds (the source clock), for smoothing/staleness in B5. */
    val emittedAtMs: Long,
    /**
     * IMAGE only: `ImageProxy.imageInfo.rotationDegrees` — the clockwise turn that makes the JPEG
     * upright (card B5). The bytes themselves stay sensor-oriented (card B4 encoded them that way);
     * a consumer that embeds the frame MUST rotate it first. 0 for text/barcode signals.
     */
    val rotationDegrees: Int = 0,
) {
    init {
        require(confidence in 0f..1f) { "confidence must be 0..1, was $confidence" }
        require(rotationDegrees % 90 == 0) { "rotationDegrees must be a multiple of 90, was $rotationDegrees" }
        require(rotationDegrees == 0 || kind == ScanKind.IMAGE) {
            "only IMAGE signals carry sensor rotation"
        }
        when (kind) {
            ScanKind.BARCODE, ScanKind.TEXT -> require(payload is ScanPayload.Text) {
                "$kind signal must carry text"
            }
            ScanKind.IMAGE -> require(payload is ScanPayload.Jpeg) {
                "IMAGE signal must carry jpeg bytes"
            }
        }
    }

    val text: String? get() = (payload as? ScanPayload.Text)?.value
    val jpeg: ByteArray? get() = (payload as? ScanPayload.Jpeg)?.bytes

    companion object {
        /** A decoded barcode is exact: no ML Kit score exists, so 1.0 is the honest value. */
        const val BARCODE_CONFIDENCE = 1.0f

        /** OCR words are a hint, not a decode: ML Kit reports no score, so use a fixed prior. */
        const val OCR_CONFIDENCE = 0.75f

        /** The frame itself is not a "detection"; it is whatever the camera saw. */
        const val IMAGE_CONFIDENCE = 1.0f

        fun barcode(value: String, atMs: Long): ScanSignal = ScanSignal(
            kind = ScanKind.BARCODE,
            payload = ScanPayload.Text(value),
            confidence = BARCODE_CONFIDENCE,
            emittedAtMs = atMs,
        )

        fun text(value: String, atMs: Long, confidence: Float = OCR_CONFIDENCE): ScanSignal =
            ScanSignal(
                kind = ScanKind.TEXT,
                payload = ScanPayload.Text(value),
                confidence = confidence,
                emittedAtMs = atMs,
            )

        fun image(jpeg: ByteArray, atMs: Long, rotationDegrees: Int = 0): ScanSignal = ScanSignal(
            kind = ScanKind.IMAGE,
            payload = ScanPayload.Jpeg(jpeg),
            confidence = IMAGE_CONFIDENCE,
            emittedAtMs = atMs,
            rotationDegrees = rotationDegrees,
        )
    }
}
