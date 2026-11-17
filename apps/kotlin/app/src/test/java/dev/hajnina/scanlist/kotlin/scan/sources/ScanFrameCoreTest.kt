package dev.hajnina.scanlist.kotlin.scan.sources

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B4 Done-when: the sources unit-tested with fake frames.
 *
 * These are the real assertions for this card: synthetic YUV frames, a fake clock, a recording JPEG
 * encoder and plain data in/out. ML Kit itself is *not* exercised here (bundled ML Kit needs an
 * Android device/emulator — the real-artifact path is build-verified by CI, and on-device behaviour
 * is documented as PENDING PHONE in the card's Notes).
 */
class ScanFrameCoreTest {

    @Test
    fun `barcode hits become BARCODE signals with the decoded text`() {
        val core = ScanFrameCore(clock = FakeClock())
        val signals = core.onBarcodeHits(listOf(BarcodeHit("5012345678900", "EAN_13")), nowMs = 0)

        assertEquals(1, signals.size)
        val signal = signals.single()
        assertEquals(ScanKind.BARCODE, signal.kind)
        assertEquals("5012345678900", signal.text)
        assertNull(signal.jpeg)
        assertEquals(ScanSignal.BARCODE_CONFIDENCE, signal.confidence, 0f)
        assertEquals(0L, signal.emittedAtMs)
    }

    @Test
    fun `the same barcode inside the dedupe window is suppressed`() {
        val core = ScanFrameCore(clock = FakeClock())

        assertEquals(1, core.onBarcodeHits(listOf(BarcodeHit("111")), nowMs = 0).size)
        assertTrue(core.onBarcodeHits(listOf(BarcodeHit("111")), nowMs = 1_000).isEmpty())
        assertTrue(core.onBarcodeHits(listOf(BarcodeHit("111")), nowMs = 2_999).isEmpty())
        assertEquals(1, core.onBarcodeHits(listOf(BarcodeHit("111")), nowMs = 3_000).size)
    }

    @Test
    fun `two barcodes in one frame both survive if distinct`() {
        val core = ScanFrameCore(clock = FakeClock())
        val signals = core.onBarcodeHits(
            listOf(BarcodeHit("111"), BarcodeHit("222")),
            nowMs = 0,
        )
        assertEquals(listOf("111", "222"), signals.map { it.text })
    }

    @Test
    fun `OCR emits one TEXT signal per line with that line's confidence`() {
        val core = ScanFrameCore(clock = FakeClock())
        val signals = core.onOcrLines(
            listOf(OcrLine("Fresh milk", 0.9f), OcrLine("1 L", 0.3f)),
            nowMs = 0,
        )

        assertEquals(2, signals.size)
        assertEquals(listOf("Fresh milk", "1 L"), signals.map { it.text })
        assertTrue(signals.all { it.kind == ScanKind.TEXT })
        assertEquals(listOf(0.9f, 0.3f), signals.map { it.confidence })
    }

    @Test
    fun `OCR lines are capped at 16 in detection order`() {
        val core = ScanFrameCore(clock = FakeClock())
        val lines = (1..20).map { OcrLine("word %02d".format(it)) }

        val signals = core.onOcrLines(lines, nowMs = 0)

        assertEquals(OcrLineBatcher.MAX_LINES_PER_FRAME, signals.size)
        assertEquals(16, signals.size)
        assertEquals((1..16).map { "word %02d".format(it) }, signals.map { it.text })
    }

    @Test
    fun `the same OCR line inside the repeat window emits nothing`() {
        val core = ScanFrameCore(clock = FakeClock())
        assertEquals(1, core.onOcrLines(listOf(OcrLine("Olive oil")), nowMs = 0).size)
        assertTrue(core.onOcrLines(listOf(OcrLine("Olive oil")), nowMs = 500).isEmpty())
        assertEquals(1, core.onOcrLines(listOf(OcrLine("Olive oil")), nowMs = 1_500).size)
    }

    @Test
    fun `a frame is downscaled to 384 px and emitted as IMAGE`() {
        val encoder = RecordingJpegEncoder(result = byteArrayOf(1, 2, 3, 4))
        val core = ScanFrameCore(clock = FakeClock(), jpegEncoder = encoder)
        val frame = yuv420Constant(width = 1080, height = 1920)

        val signal = core.onFrame(frame, nowMs = 0)

        assertNotNull(signal)
        assertEquals(ScanKind.IMAGE, signal!!.kind)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), signal.jpeg)
        assertNull(signal.text)
        assertEquals(ScanSignal.IMAGE_CONFIDENCE, signal.confidence, 0f)

        // The encoder must have been given the 384 px short-side frame, not the camera frame.
        val call = encoder.last!!
        assertEquals(384, call.width)
        assertEquals(682, call.height)
        assertEquals(384 * 682 + 2 * 192 * 341, call.nv21Size)
        assertEquals(ScanFrameCore.DEFAULT_JPEG_QUALITY, call.quality)
    }

    @Test
    fun `image frames are gated to 2_5 fps`() {
        val encoder = RecordingJpegEncoder()
        val core = ScanFrameCore(clock = FakeClock(), jpegEncoder = encoder)
        val frame = yuv420Constant(width = 720, height = 1280)

        assertNotNull(core.onFrame(frame, nowMs = 0))
        assertNull(core.onFrame(frame, nowMs = 100))
        assertNull(core.onFrame(frame, nowMs = 399))
        assertNotNull(core.onFrame(frame, nowMs = 400))
        assertEquals(2, encoder.calls.size)
    }

    @Test
    fun `an encoder failure emits nothing`() {
        val core = ScanFrameCore(clock = FakeClock(), jpegEncoder = RecordingJpegEncoder(result = null))
        assertNull(core.onFrame(yuv420Constant(640, 480), nowMs = 0))
    }

    @Test
    fun `a small frame is not upscaled before encoding`() {
        val encoder = RecordingJpegEncoder()
        val core = ScanFrameCore(clock = FakeClock(), jpegEncoder = encoder)

        assertNotNull(core.onFrame(yuv420Constant(320, 240), nowMs = 0))
        assertEquals(320, encoder.last!!.width)
        assertEquals(240, encoder.last!!.height)
    }

    @Test
    fun `target size helper matches the geometry rule`() {
        val core = ScanFrameCore(clock = FakeClock())
        assertEquals(FrameSize(384, 682), core.targetSizeFor(1080, 1920))
    }

    @Test
    fun `signal kinds enforce their payload`() {
        val barcode = ScanSignal.barcode("123", 0)
        val text = ScanSignal.text("Milk", 0)
        val image = ScanSignal.image(byteArrayOf(9), 0)

        assertEquals(setOf(ScanKind.BARCODE, ScanKind.TEXT, ScanKind.IMAGE), setOf(barcode.kind, text.kind, image.kind))
        assertTrue(barcode.payload is ScanPayload.Text)
        assertTrue(text.payload is ScanPayload.Text)
        assertTrue(image.payload is ScanPayload.Jpeg)
        assertFalse(barcode.confidence > 1f)
    }

    @Test
    fun `jpeg payload equality is by content`() {
        assertEquals(ScanPayload.Jpeg(byteArrayOf(1, 2)), ScanPayload.Jpeg(byteArrayOf(1, 2)))
        assertFalse(ScanPayload.Jpeg(byteArrayOf(1, 2)) == ScanPayload.Jpeg(byteArrayOf(2, 1)))
        assertEquals("Jpeg(2 B)", ScanPayload.Jpeg(byteArrayOf(1, 2)).toString())
    }

    @Test(expected = IllegalArgumentException::class)
    fun `confidence outside 0 to 1 is rejected`() {
        ScanSignal.text("Milk", 0, confidence = 1.5f)
    }
}
