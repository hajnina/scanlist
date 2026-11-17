package dev.hajnina.scanlist.kotlin.ui

import dev.hajnina.scanlist.kotlin.settings.ModelProbe
import dev.hajnina.scanlist.kotlin.settings.ModelStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
                modelStatus = readyModel,
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
        assertNull(scanBanner(ScanBannerState(cameraGranted = true, modelStatus = readyModel)))
    }

    @Test
    fun `denied camera permission wins and offers app settings`() {
        val banner = scanBanner(
            ScanBannerState(
                cameraGranted = false,
                modelStatus = missingModel,
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
                modelStatus = missingModel,
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
    fun `a wrong-size or unreadable model gets its own label, not E_NO_MODEL`() {
        val wrongSize = scanBanner(
            ScanBannerState(
                cameraGranted = true,
                modelStatus = ModelStatus.Present("/models/embeddinggemma-2-740m.litertlm", 1024),
            ),
        )!!
        assertEquals(ScanBannerKind.MODEL, wrongSize.kind)
        assertFalse(wrongSize.title.contains(ModelProbe.E_NO_MODEL))
        assertTrue(wrongSize.title.contains("size"))
        assertTrue(wrongSize.body.contains("expected"))

        val unreadable = scanBanner(
            ScanBannerState(
                cameraGranted = true,
                modelStatus = ModelStatus.Unreadable("/models/embeddinggemma-2-740m.litertlm", "not readable by this app"),
            ),
        )!!
        assertEquals(ScanBannerKind.MODEL, unreadable.kind)
        assertFalse(unreadable.title.contains(ModelProbe.E_NO_MODEL))
        assertTrue(unreadable.title.contains("unreadable", ignoreCase = true))
        assertTrue(unreadable.body.contains("not readable by this app"))
    }

    @Test
    fun `runtime embedder failure is shown verbatim`() {
        val banner = scanBanner(
            ScanBannerState(cameraGranted = true, modelStatus = readyModel, embedError = "litert: no images"),
        )!!
        assertEquals(ScanBannerKind.EMBED, banner.kind)
        assertEquals("litert: no images", banner.body)
    }

    @Test
    fun `low light is advice, and ranks above offline`() {
        val banner = scanBanner(
            ScanBannerState(
                cameraGranted = true,
                modelStatus = readyModel,
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
            ScanBannerState(cameraGranted = true, modelStatus = readyModel, offline = true),
        )!!
        assertEquals(ScanBannerKind.OFFLINE, banner.kind)
        assertTrue(banner.title.contains("OCR", ignoreCase = true))
        assertTrue(banner.body.contains("still rank"))
    }

    @Test
    fun `offline without a known model state holds the model banner back`() {
        // modelStatus = null means "not probed yet", not "missing": only an observed bad status claims it.
        val banner = scanBanner(ScanBannerState(cameraGranted = true, offline = true))!!
        assertEquals(ScanBannerKind.OFFLINE, banner.kind)
    }

    @Test
    fun `every banner body is a complete sentence`() {
        val states = listOf(
            ScanBannerState(cameraGranted = false),
            ScanBannerState(cameraGranted = true, modelStatus = missingModel),
            ScanBannerState(cameraGranted = true, modelStatus = ModelStatus.Present("/m", 1024)),
            ScanBannerState(cameraGranted = true, modelStatus = ModelStatus.Unreadable("/m", "not a regular file")),
            ScanBannerState(cameraGranted = true, modelStatus = readyModel, embedError = "x"),
            ScanBannerState(cameraGranted = true, modelStatus = readyModel, lowLight = LowLightState.DIM),
            ScanBannerState(cameraGranted = true, modelStatus = readyModel, offline = true),
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

private val readyModel =
    ModelStatus.Present("/models/embeddinggemma-2-740m.litertlm", ModelProbe.EXPECTED_BYTES)
private val missingModel = ModelStatus.Missing("/models/embeddinggemma-2-740m.litertlm")
