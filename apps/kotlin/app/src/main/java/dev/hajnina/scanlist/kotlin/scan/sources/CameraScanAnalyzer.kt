package dev.hajnina.scanlist.kotlin.scan.sources

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

// Android glue for card B4. Everything decision-shaped lives in ScanFrameCore (pure, unit-tested);
// this file only copies CameraX planes, calls the bundled ML Kit clients and forwards results.
// The bundled (play-services-free) artifacts are build-verified only: they cannot run on the JVM,
// so the seams below are what a future instrumented test would fake.

/** ML Kit barcode scanner behind a callback seam. */
fun interface BarcodeReader {
    fun read(image: InputImage, onResult: (List<BarcodeHit>) -> Unit)

    fun close() {}
}

/** ML Kit text recogniser behind a callback seam; returns the visible lines, top-to-bottom. */
fun interface TextReader {
    fun read(image: InputImage, onResult: (List<OcrLine>) -> Unit)

    fun close() {}
}

/** Real bundled barcode scanner (com.google.mlkit:barcode-scanning, no Play Services needed). */
class MlKitBarcodeReader : BarcodeReader {

    private val client: BarcodeScanner by lazy { BarcodeScanning.getClient() }

    override fun read(image: InputImage, onResult: (List<BarcodeHit>) -> Unit) {
        client.process(image)
            .addOnSuccessListener { barcodes ->
                onResult(
                    barcodes.mapNotNull { barcode ->
                        val value = barcode.rawValue?.trim().orEmpty()
                        if (value.isEmpty()) null else BarcodeHit(value, formatName(barcode.format))
                    },
                )
            }
            .addOnFailureListener { onResult(emptyList()) }
    }

    override fun close() {
        client.close()
    }

    private fun formatName(format: Int): String = when (format) {
        Barcode.FORMAT_EAN_13 -> "EAN_13"
        Barcode.FORMAT_EAN_8 -> "EAN_8"
        Barcode.FORMAT_UPC_A -> "UPC_A"
        Barcode.FORMAT_UPC_E -> "UPC_E"
        Barcode.FORMAT_CODE_128 -> "CODE_128"
        Barcode.FORMAT_CODE_39 -> "CODE_39"
        Barcode.FORMAT_QR_CODE -> "QR_CODE"
        Barcode.FORMAT_DATA_MATRIX -> "DATA_MATRIX"
        else -> "OTHER"
    }
}

/** Real bundled Latin text recogniser (com.google.mlkit:text-recognition). */
class MlKitTextReader : TextReader {

    private val client: TextRecognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    override fun read(image: InputImage, onResult: (List<OcrLine>) -> Unit) {
        client.process(image)
            .addOnSuccessListener { text ->
                // One OcrLine per visible line, in ML Kit's reading order (blocks -> lines), with the
                // line's real score (Text.Line.getConfidence() is public — see OcrLine's KDoc);
                // nothing is ever averaged across lines (RANK.md §2.2).
                onResult(
                    text.textBlocks.flatMap { block ->
                        block.lines.map { line ->
                            val c = line.confidence
                            OcrLine(
                                line.text,
                                c.takeIf { it.isFinite() }?.coerceIn(0f, 1f) ?: ScanSignal.OCR_CONFIDENCE,
                            )
                        }
                    },
                )
            }
            .addOnFailureListener { onResult(emptyList()) }
    }

    override fun close() {
        client.close()
    }
}

/** `YuvImage.compressToJpeg` — the only Android graphics step of the frame→JPEG path. */
object AndroidJpegEncoder : JpegEncoder {
    override fun encode(nv21: ByteArray, width: Int, height: Int, quality: Int): ByteArray? =
        runCatching {
            ByteArrayOutputStream().use { out ->
                val encoded = YuvImage(nv21, ImageFormat.NV21, width, height, null)
                    .compressToJpeg(Rect(0, 0, width, height), quality, out)
                // B4 review nit: the boolean is false when the YUV buffer produced no JPEG; handing
                // those bytes on would give the embedder a broken image instead of "no frame".
                if (encoded) out.toByteArray() else null
            }
        }.getOrNull()
}

/** CameraX analysis analyzer: copy planes, ask ML Kit, hand everything to [ScanFrameCore]. */
class CameraScanAnalyzer(
    private val core: ScanFrameCore,
    private val barcodeReader: BarcodeReader = MlKitBarcodeReader(),
    private val textReader: TextReader = MlKitTextReader(),
    private val clock: Clock = Clock { android.os.SystemClock.elapsedRealtime() },
    private val onSignal: (ScanSignal) -> Unit = {},
    /**
     * Card B7: mean luma of each frame that passed [ScanFrameCore]'s 2.5 fps gate, for the low-light
     * advice banner. Runs on the analysis thread, must be cheap and must not throw; the gate means it
     * fires at most 2.5 times a second, not at preview rate.
     */
    private val onLuma: (Double) -> Unit = {},
) : ImageAnalysis.Analyzer {

    /** Frames between analyze() and both ML Kit callbacks finishing (see close()). */
    private val inFlight = AtomicInteger(0)
    private val closed = AtomicBoolean(false)
    private val readersClosed = AtomicBoolean(false)

    override fun analyze(image: ImageProxy) {
        if (closed.get()) {
            image.close()
            return
        }
        val media = image.image
        if (media == null) {
            image.close()
            return
        }

        // Two async ML Kit tasks; the ImageProxy must stay open until both finish. ML Kit reads the
        // media Image directly, so it has to be closed after the callbacks, never before.
        val pending = AtomicInteger(2)
        val closedOnce = AtomicBoolean(false)
        val finish = {
            if (pending.decrementAndGet() == 0 && closedOnce.compareAndSet(false, true)) {
                image.close()
                if (inFlight.decrementAndGet() == 0) closeReadersIfClosed()
            }
        }
        inFlight.incrementAndGet()

        // B4 review nit: fromMediaImage/onFrame used to sit OUTSIDE the try, so a throw there left the
        // ImageProxy open forever (camera stalls after a few frames). Everything is inside now, and the
        // `finish` calls in the catch blocks remain balanced (2 decrements either way).
        try {
            val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)

            // Image path is synchronous; the core gates it to ≤ 2.5 fps BEFORE the plane copy runs.
            // The JPEG is SENSOR-oriented: rotationDegrees is carried on the signal (card B5 rotates
            // the frame upright before embedding) as well as handed to ML Kit.
            core.onFrame(clock.nowMs(), image.imageInfo.rotationDegrees) {
                runCatching { ImageProxyFrames.toYuv420(image) }
                    .getOrNull()
                    ?.also { frame ->
                        // Card B7: only frames the scan gate accepted are measured, so the luma
                        // sampler has the same cadence as the ranking work and never adds a
                        // per-preview-frame cost. A luma failure must not lose the frame.
                        runCatching { onLuma(Luma.mean(frame)) }
                    }
            }?.let(onSignal)

            try {
                barcodeReader.read(input) { hits ->
                    runCatching { core.onBarcodeHits(hits, clock.nowMs()).forEach(onSignal) }
                    finish()
                }
            } catch (t: Throwable) {
                finish()
            }

            try {
                textReader.read(input) { lines ->
                    runCatching { core.onOcrLines(lines, clock.nowMs()).forEach(onSignal) }
                    finish()
                }
            } catch (t: Throwable) {
                finish()
            }
        } catch (t: Throwable) {
            // Neither ML Kit client was asked, so both pending slots are released here.
            finish()
            finish()
        }
    }

    /**
     * Close the ML Kit clients once no frame is in flight (B4 review nit: `close()` used to close
     * clients under running tasks). `analyze` refuses new frames after this call.
     */
    fun close() {
        closed.set(true)
        closeReadersIfClosed()
    }

    private fun closeReadersIfClosed() {
        if (!closed.get() || inFlight.get() > 0) return
        if (!readersClosed.compareAndSet(false, true)) return
        barcodeReader.close()
        textReader.close()
    }
}

/** Copies CameraX's strided YUV_420_888 planes into the pure [Yuv420Frame] shape. */
internal object ImageProxyFrames {

    fun toYuv420(image: ImageProxy): Yuv420Frame? {
        val planes = image.planes
        if (planes.size < 3) return null
        val y = planes[0]
        val u = planes[1]
        val v = planes[2]
        return Yuv420Frame(
            width = image.width,
            height = image.height,
            y = y.buffer.toByteArray(),
            yRowStride = y.rowStride,
            yPixelStride = y.pixelStride,
            u = u.buffer.toByteArray(),
            uRowStride = u.rowStride,
            uPixelStride = u.pixelStride,
            v = v.buffer.toByteArray(),
            vRowStride = v.rowStride,
            vPixelStride = v.pixelStride,
        )
    }

    private fun java.nio.ByteBuffer.toByteArray(): ByteArray {
        val dup = duplicate()
        dup.rewind()
        val bytes = ByteArray(dup.remaining())
        dup.get(bytes)
        return bytes
    }
}
