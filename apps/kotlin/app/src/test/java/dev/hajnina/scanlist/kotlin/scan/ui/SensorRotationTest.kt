package dev.hajnina.scanlist.kotlin.scan.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Card B5's mandatory sensor-orientation decision: the IMAGE signal's JPEG is sensor-oriented, so the
 * scan screen rotates it by exactly `rotationDegrees` clockwise **before** embedding. The mapping is
 * pure arithmetic and this test is the JVM oracle for the pixel job ([JpegRotation], which needs a
 * Bitmap and therefore a device).
 */
class SensorRotationTest {

    @Test
    fun `camera values pass through unchanged`() {
        assertEquals(0, SensorRotation.normalize(0))
        assertEquals(90, SensorRotation.normalize(90))
        assertEquals(180, SensorRotation.normalize(180))
        assertEquals(270, SensorRotation.normalize(270))
        // CameraX always reports [0, 360), and the upright rotation is exactly the sensor rotation.
        for (degrees in listOf(0, 90, 180, 270)) {
            assertEquals(degrees, SensorRotation.uprightRotation(degrees))
            assertEquals(degrees != 0, SensorRotation.needsRotation(degrees))
        }
    }

    @Test
    fun `out of range values fold into one clockwise quarter turn`() {
        assertEquals(270, SensorRotation.normalize(-90))
        assertEquals(90, SensorRotation.normalize(450))
        assertEquals(0, SensorRotation.normalize(360))
        assertEquals(180, SensorRotation.normalize(-180))
        assertEquals(90, SensorRotation.normalize(810))
        assertEquals(0, SensorRotation.normalize(0))
    }

    @Test
    fun `a non quarter turn is a programming error, not a silent crop`() {
        for (degrees in listOf(1, 45, 89, -45, 91)) {
            try {
                SensorRotation.normalize(degrees)
                fail("$degrees should be rejected")
            } catch (expected: IllegalArgumentException) {
                assertTrue(expected.message!!.contains("multiple of 90"))
            }
        }
    }

    @Test
    fun `a quarter turn swaps the pixel size and a half turn does not`() {
        assertEquals(480 to 640, SensorRotation.rotatedSize(640, 480, 90))
        assertEquals(480 to 640, SensorRotation.rotatedSize(640, 480, 270))
        assertEquals(640 to 480, SensorRotation.rotatedSize(640, 480, 180))
        assertEquals(640 to 480, SensorRotation.rotatedSize(640, 480, 0))
        assertTrue(SensorRotation.needsRotation(-90))
        assertFalse(SensorRotation.needsRotation(360))
    }

    @Test
    fun `a non positive size is rejected`() {
        try {
            SensorRotation.rotatedSize(0, 480, 90)
            fail("0 width should be rejected")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("positive"))
        }
    }
}
