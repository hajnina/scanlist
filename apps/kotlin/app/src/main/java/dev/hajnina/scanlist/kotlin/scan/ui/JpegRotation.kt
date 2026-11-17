package dev.hajnina.scanlist.kotlin.scan.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import java.io.ByteArrayOutputStream

/**
 * The pixel half of card B5's sensor-orientation decision: rotate a sensor-oriented JPEG upright with
 * an Android [Matrix] (the same call Bonsai/MnemoThera use for their camera frames).
 *
 * Thin and untested on the JVM on purpose (android.graphics is not available there): the *decision* —
 * how many degrees, whether at all — is [SensorRotation] + [ScanSession] and is unit-tested; this file
 * only executes it. Runs on the scan worker thread, never the main thread.
 */
object JpegRotation : ImageRotator {

    /** Same quality the sampler encoded at (card B4's `DEFAULT_JPEG_QUALITY`). */
    private const val QUALITY = 80

    override fun rotateClockwise(jpeg: ByteArray, degrees: Int): ByteArray? {
        val rotation = SensorRotation.uprightRotation(degrees)
        if (rotation == 0) return jpeg
        return runCatching {
            val source = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return null
            val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
            val rotated = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            try {
                ByteArrayOutputStream().use { out ->
                    rotated.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
                    out.toByteArray()
                }
            } finally {
                rotated.recycle()
                source.recycle()
            }
        }.getOrNull()
    }
}
