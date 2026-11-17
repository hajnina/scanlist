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
                YuvImage(nv21, ImageFormat.NV21, width, height, null)
                    .compressToJpeg(Rect(0, 0, width, height), quality, out)
                out.toByteArray()
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
) : ImageAnalysis.Analyzer {

    override fun analyze(image: ImageProxy) {
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
            if (pending.decrementAndGet() == 0 && closedOnce.compareAndSet(false, true)) image.close()
        }

        val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)

        // Image path is synchronous; the core gates it to ≤ 2.5 fps BEFORE the plane copy runs.
        // NOTE (B4 review): the JPEG is SENSOR-oriented — rotationDegrees goes to ML Kit only,
        // not into the JPEG bytes. IMAGE signals are therefore sideways (usually 90°) relative
        // to what the user sees; B5 must rotate before embedding (or we wire rotation into the
        // encoder once a device can verify the result).
        core.onFrame(clock.nowMs()) {
            runCatching { ImageProxyFrames.toYuv420(image) }.getOrNull()
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
    }

    fun close() {
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
