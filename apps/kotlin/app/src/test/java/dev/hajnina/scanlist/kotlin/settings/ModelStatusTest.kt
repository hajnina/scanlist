package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.EmbedderConfig
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Card B6 "model file status + path": every branch of the probe, resolved without a 484 MB fixture
 * ([ModelProbe.resolve] is the decision, [ModelProbe.status] only reads the filesystem).
 */
class ModelStatusTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `missing bundle is E_NO_MODEL, not a crash`() {
        val status = ModelProbe.resolve("/data/x/models/m.litertlm", exists = false, isFile = false, readable = false, bytes = 0)
        assertTrue(status is ModelStatus.Missing)
        assertFalse(status.isReady)
        assertTrue(ModelProbe.line(status).startsWith(ModelProbe.E_NO_MODEL))
        assertTrue(ModelProbe.line(status).contains("/data/x/models/m.litertlm"))
    }

    @Test
    fun `pinned size is ready, any other size is present but not ready`() {
        val exact = ModelProbe.resolve("m", exists = true, isFile = true, readable = true, bytes = ModelProbe.EXPECTED_BYTES)
        assertTrue(exact is ModelStatus.Present)
        assertTrue(exact.isReady)
        assertTrue(ModelProbe.sizeNote(ModelProbe.EXPECTED_BYTES).contains("matches"))

        val wrong = ModelProbe.resolve("m", exists = true, isFile = true, readable = true, bytes = 1024)
        assertTrue(wrong is ModelStatus.Present)
        assertFalse(wrong.isReady)
        assertTrue(ModelProbe.sizeNote(1024).contains("expected"))
        assertTrue(ModelProbe.line(wrong).contains("wrong or truncated"))
    }

    @Test
    fun `a directory or an unreadable file is reported with the reason`() {
        val directory = ModelProbe.resolve("m", exists = true, isFile = false, readable = true, bytes = 0)
        assertTrue(directory is ModelStatus.Unreadable)
        assertTrue((directory as ModelStatus.Unreadable).reason.contains("regular file"))

        val unreadable = ModelProbe.resolve("m", exists = true, isFile = true, readable = false, bytes = 10)
        assertTrue(unreadable is ModelStatus.Unreadable)
        assertTrue((unreadable as ModelStatus.Unreadable).reason.contains("scripts/model.sh push"))
        assertTrue(ModelProbe.line(unreadable).startsWith("unreadable"))
    }

    @Test
    fun `an empty file is unreadable, not present`() {
        val status = ModelProbe.resolve("m", exists = true, isFile = true, readable = true, bytes = 0)
        assertTrue(status is ModelStatus.Unreadable)
        assertTrue((status as ModelStatus.Unreadable).reason.contains("empty"))
    }

    @Test
    fun `formatBytes matches the documented bundle size`() {
        assertEquals("484,622,336 B · 462.2 MiB", ModelProbe.formatBytes(ModelProbe.EXPECTED_BYTES))
        assertEquals("0 B · 0.0 MiB", ModelProbe.formatBytes(0))
        assertEquals("1,024 B · 0.0 MiB", ModelProbe.formatBytes(1024))
        assertEquals(484_622_336L, ModelProbe.EXPECTED_BYTES)
    }

    @Test
    fun `expected sha256 is the pinned bundle hash shared with the embedder and model script`() {
        assertEquals(EmbedderConfig.DEFAULT_MODEL_SHA256, ModelProbe.EXPECTED_SHA256)
        assertEquals(64, ModelProbe.EXPECTED_SHA256.length)
        assertTrue(ModelProbe.PUSH_HINT.contains("scripts/model.sh push"))
    }

    @Test
    fun `status reads a real file and reports its absolute path and size`() {
        val model = temp.newFile("model.litertlm")
        model.writeBytes(ByteArray(3))
        val status = ModelProbe.status(model)
        assertTrue(status is ModelStatus.Present)
        val present = status as ModelStatus.Present
        assertEquals(model.absolutePath, present.path)
        assertEquals(3L, present.bytes)
        assertFalse(present.isReady)
    }

    @Test
    fun `status of a nonexistent file is missing with the absolute path`() {
        val model = File(temp.root, "nope/model.litertlm")
        val status = ModelProbe.status(model)
        assertTrue(status is ModelStatus.Missing)
        assertEquals(model.absolutePath, status.path)
    }
}
