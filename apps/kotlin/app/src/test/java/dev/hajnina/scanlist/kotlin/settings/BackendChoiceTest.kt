package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.EmbedBackend
import dev.hajnina.scanlist.embed.EmbedderConfig
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B6: the picker's four options must map onto shared/android-embed's [EmbedBackend] ladder
 * honestly — Auto is the shipped GPU→CPU order, an explicit pick is strict so the latency card can
 * never label a CPU measurement "GPU", and NPU is opt-in/experimental (never in Auto).
 */
class BackendChoiceTest {

    @Test
    fun `auto is the shipped gpu then cpu ladder and never npu`() {
        assertEquals(listOf(EmbedBackend.GPU, EmbedBackend.CPU), BackendChoice.AUTO.candidates())
        assertFalse(EmbedBackend.NPU in BackendChoice.AUTO.candidates())
    }

    @Test
    fun `explicit choices are strict single-backend ladders`() {
        assertEquals(listOf(EmbedBackend.GPU), BackendChoice.GPU.candidates())
        assertEquals(listOf(EmbedBackend.CPU), BackendChoice.CPU.candidates())
        assertEquals(listOf(EmbedBackend.NPU), BackendChoice.NPU.candidates())
    }

    @Test
    fun `every backend is reachable from exactly one option and all options are covered`() {
        assertEquals(
            EmbedBackend.entries.toSet(),
            BackendChoice.entries.flatMap { it.candidates() }.toSet(),
        )
    }

    @Test
    fun `npu is the only experimental option`() {
        assertEquals(listOf(BackendChoice.NPU), BackendChoice.entries.filter { it.experimental })
        assertTrue(BackendChoice.NPU.label.contains("NPU"))
    }

    @Test
    fun `ids round-trip and unknown or blank ids fall back to auto`() {
        BackendChoice.entries.forEach { choice ->
            assertEquals(choice, BackendChoice.fromId(choice.id))
            assertEquals(choice, BackendChoice.fromId(" ${choice.id.uppercase()} "))
        }
        assertEquals(BackendChoice.AUTO, BackendChoice.fromId(null))
        assertEquals(BackendChoice.AUTO, BackendChoice.fromId(""))
        assertEquals(BackendChoice.AUTO, BackendChoice.fromId("tpu"))
        assertEquals(BackendChoice.AUTO, BackendChoice.DEFAULT)
    }

    @Test
    fun `config carries the choice's ladder and only npu opts in to the npu`() {
        val model = File("/tmp/model.litertlm")
        BackendChoice.entries.forEach { choice ->
            val config = choice.config(model, modelId = "embeddinggemma-2-740m")
            assertEquals(choice.candidates(), config.backendOrder)
            assertEquals(choice.candidates(), config.candidates())
            assertEquals(choice == BackendChoice.NPU, config.allowNpu)
            assertEquals(model, config.modelFile)
            assertEquals("embeddinggemma-2-740m", config.modelId)
        }
    }

    @Test
    fun `config defaults to the pinned model id and sensible sizes`() {
        val config = BackendChoice.AUTO.config(File("/tmp/model.litertlm"))
        assertEquals(EmbedderConfig.DEFAULT_MODEL_ID, config.modelId)
        assertEquals(768, config.nativeDims)
        assertEquals(2048, config.maxInputLength)
        assertEquals(70, config.visionTokensPerImage)
    }

    @Test
    fun `ladder labels tell the user what will be tried`() {
        assertEquals("GPU → CPU fallback", BackendChoice.AUTO.ladderLabel())
        assertTrue(BackendChoice.NPU.ladderLabel().contains("experimental"))
        BackendChoice.entries.forEach { assertTrue(it.ladderLabel().isNotBlank()) }
    }
}
