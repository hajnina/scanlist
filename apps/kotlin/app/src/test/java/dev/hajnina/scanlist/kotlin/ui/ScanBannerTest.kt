package dev.hajnina.scanlist.kotlin.ui

import dev.hajnina.scanlist.kotlin.settings.ModelProbe
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B7 — one banner at a time, in a fixed priority order, and never a claim about something the
 * screen has not actually observed (`null` inputs stay silent).
 */
class ScanBannerTest {

    @Test
    fun `a healthy scan has no banner`() {
        val banner = scanBanner(
            ScanBannerState(
                cameraGranted = true,
                modelReady = true,
                lowLight = LowLightState.OK,
                offline = false,
                embedError = null,
            ),
        )
        assertNull(banner)
    }

    @Test
    fun `unknown inputs stay silent`() {
        // Nothing reported yet: permission null, model null, light unknown.
        assertNull(scanBanner(ScanBannerState()))
    }

    @Test
    fun `unknown low light is not dim`() {
        assertNull(scanBanner(ScanBannerState(cameraGranted = true, modelReady = true)))
    }

    @Test
    fun `denied camera permission wins and offers app settings`() {
        val banner = scanBanner(
            ScanBannerState(
                cameraGranted = false,
                modelReady = false,
                lowLight = LowLightState.DIM,
                offline = true,
                embedError = "boom",
            ),
        )!!
        assertEquals(ScanBannerKind.CAMERA, banner.kind)
        assertEquals(ScanBannerAction.OPEN_SETTINGS, banner.action)
        assertTrue(banner.title.lowercase().contains("camera"))
    }

    @Test
    fun `missing model beats every lower rung and shows the exact push hint`() {
        val banner = scanBanner(
            ScanBannerState(
                cameraGranted = true,
                modelReady = false,
                lowLight = LowLightState.DIM,
                offline = true,
                embedError = "open failed",
            ),
        )!!
        assertEquals(ScanBannerKind.MODEL, banner.kind)
        assertEquals(ModelProbe.PUSH_HINT, banner.body)
        assertTrue(banner.title.contains(ModelProbe.E_NO_MODEL))
    }

    @Test
    fun `runtime embedder failure is shown verbatim`() {
        val banner = scanBanner(
            ScanBannerState(cameraGranted = true, modelReady = true, embedError = "litert: no images"),
        )!!
        assertEquals(ScanBannerKind.EMBED, banner.kind)
        assertEquals("litert: no images", banner.body)
    }

    @Test
    fun `low light is advice, and ranks above offline`() {
        val banner = scanBanner(
            ScanBannerState(
                cameraGranted = true,
                modelReady = true,
                lowLight = LowLightState.DIM,
                offline = true,
            ),
        )!!
        assertEquals(ScanBannerKind.LOW_LIGHT, banner.kind)
        assertEquals(ScanBannerAction.NONE, banner.action)
    }

    @Test
    fun `offline explains that OCR and image still rank`() {
        val banner = scanBanner(
            ScanBannerState(cameraGranted = true, modelReady = true, offline = true),
        )!!
        assertEquals(ScanBannerKind.OFFLINE, banner.kind)
        assertTrue(banner.title.contains("OCR", ignoreCase = true))
        assertTrue(banner.body.contains("still rank"))
    }

    @Test
    fun `offline without a known model state holds the model banner back`() {
        // modelReady = null means "not probed yet", not "missing": only a positive false claims it.
        val banner = scanBanner(ScanBannerState(cameraGranted = true, offline = true))!!
        assertEquals(ScanBannerKind.OFFLINE, banner.kind)
    }

    @Test
    fun `every banner body is a complete sentence`() {
        val states = listOf(
            ScanBannerState(cameraGranted = false),
            ScanBannerState(cameraGranted = true, modelReady = false),
            ScanBannerState(cameraGranted = true, modelReady = true, embedError = "x"),
            ScanBannerState(cameraGranted = true, modelReady = true, lowLight = LowLightState.DIM),
            ScanBannerState(cameraGranted = true, modelReady = true, offline = true),
        )
        states.forEach { state ->
            val banner = scanBanner(state)!!
            assertTrue("${banner.kind} title is empty", banner.title.isNotBlank())
            assertTrue("${banner.kind} body is empty", banner.body.isNotBlank())
            // EMBED shows the embedder's own text verbatim, so it is not ours to punctuate.
            if (banner.kind != ScanBannerKind.EMBED) {
                assertTrue("${banner.kind} body has no full stop", banner.body.trim().endsWith("."))
            }
        }
    }
}
