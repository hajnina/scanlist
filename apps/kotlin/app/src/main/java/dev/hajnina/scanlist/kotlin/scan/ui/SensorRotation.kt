package dev.hajnina.scanlist.kotlin.scan.ui

/**
 * Sensor-orientation math for the camera frames (card B5's mandatory decision).
 *
 * Card B4's sampler hands the scan screen JPEG bytes in **sensor orientation** and gives
 * `ImageProxy.imageInfo.rotationDegrees` to ML Kit only, so an unrotated frame is usually 90°
 * sideways. CameraX defines `rotationDegrees` as *the clockwise rotation needed to transform the
 * image buffer into the orientation the user sees*, so applying exactly those degrees clockwise to
 * the JPEG makes it upright before it is embedded.
 *
 * Pure arithmetic on purpose: the mapping is the part that can be wrong, so it is unit-tested
 * without a device (the pixel rotation lives in [JpegRotation], an Android Bitmap call).
 */
object SensorRotation {

    /** Normalised sensor rotations the encoder and CameraX may report (multiples of 90°). */
    private val VALID = setOf(0, 90, 180, 270)

    /**
     * `rotationDegrees` folded into 0/90/180/270 clockwise.
     *
     * CameraX reports values in `[0, 360)` already, but `-90`, `450` and `360` are normalised too so a
     * caller (or a future source on another API level) cannot smuggle an out-of-range value into the
     * bitmap path. A value that is not a multiple of 90° is a programming error: no camera reports it
     * and no bitmap rotation can honour it exactly.
     */
    fun normalize(degrees: Int): Int {
        require(degrees % 90 == 0) { "sensor rotation must be a multiple of 90°, was $degrees" }
        val folded = ((degrees % 360) + 360) % 360
        check(folded in VALID) { "unreachable: $degrees folded to $folded" }
        return folded
    }

    /**
     * Degrees clockwise to apply to a SENSOR-oriented JPEG so it matches what the user sees.
     *
     * `0` means "embed as-is": no decode, no re-encode, no quality loss.
     */
    fun uprightRotation(sensorRotationDegrees: Int): Int = normalize(sensorRotationDegrees)

    /** True when the frame needs a bitmap rotation before embedding. */
    fun needsRotation(sensorRotationDegrees: Int): Boolean = uprightRotation(sensorRotationDegrees) != 0

    /**
     * Pixel size after the rotation: a 90°/270° turn swaps width and height. The embedder does not
     * need it (it takes the JPEG), but a debug readout and the rotation test both do.
     */
    fun rotatedSize(width: Int, height: Int, degrees: Int): Pair<Int, Int> {
        require(width > 0 && height > 0) { "size must be positive, was ${width}x$height" }
        // A quarter turn swaps the axes; 0°/180° keep them (a half turn only flips the pixels).
        return if (uprightRotation(degrees) % 180 == 90) height to width else width to height
    }
}
