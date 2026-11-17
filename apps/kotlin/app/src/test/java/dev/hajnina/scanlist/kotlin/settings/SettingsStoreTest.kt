package dev.hajnina.scanlist.kotlin.settings

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Card B6 persistence: the backend picker survives a restart, a broken settings file falls back to
 * Auto instead of failing, and the write is atomic (same plain-java.io contract as card B2's
 * ListStore — no DataStore dependency for a few bytes).
 */
class SettingsStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `never chosen means auto and reading creates nothing`() {
        val store = SettingsStore(temp.root)
        assertEquals(BackendChoice.AUTO, store.backend())
        assertFalse(store.file.exists())
        assertFalse(File(temp.root, "settings").exists())
    }

    @Test
    fun `the choice persists under settings-embedding-json`() {
        val store = SettingsStore(temp.root)
        val written = store.setBackend(BackendChoice.GPU)
        assertEquals(File(File(temp.root, "settings"), "embedding.json"), written)
        assertTrue(written.isFile)
        assertTrue(written.readText(Charsets.UTF_8).contains("\"backend\": \"gpu\""))

        // A fresh store instance (the next app launch) reads the same choice back.
        assertEquals(BackendChoice.GPU, SettingsStore(temp.root).backend())
    }

    @Test
    fun `every choice round-trips`() {
        val store = SettingsStore(temp.root)
        BackendChoice.entries.forEach { choice ->
            store.setBackend(choice)
            assertEquals(choice, SettingsStore(temp.root).backend())
        }
    }

    @Test
    fun `writing again replaces the previous choice`() {
        val store = SettingsStore(temp.root)
        store.setBackend(BackendChoice.NPU)
        store.setBackend(BackendChoice.CPU)
        assertEquals(BackendChoice.CPU, SettingsStore(temp.root).backend())
        // One document, no numbered copies.
        assertEquals(listOf("embedding.json"), File(temp.root, "settings").list()!!.sorted())
    }

    @Test
    fun `save is atomic - no temp file left behind`() {
        val store = SettingsStore(temp.root)
        store.setBackend(BackendChoice.GPU)
        val leftovers = File(temp.root, "settings").listFiles()!!.filter { it.name.endsWith(".tmp") }
        assertEquals(emptyList<File>(), leftovers)
    }

    @Test
    fun `corrupt, empty, unknown and non-string values fall back to auto`() {
        val store = SettingsStore(temp.root)
        store.setBackend(BackendChoice.GPU)

        store.file.writeText("{ not json", Charsets.UTF_8)
        assertEquals(BackendChoice.AUTO, store.backend())

        store.file.writeText("", Charsets.UTF_8)
        assertEquals(BackendChoice.AUTO, store.backend())

        store.file.writeText("{\"embedding\":{\"backend\":\"tpu\"}}", Charsets.UTF_8)
        assertEquals(BackendChoice.AUTO, store.backend())

        store.file.writeText("{\"embedding\":{\"backend\":42}}", Charsets.UTF_8)
        assertEquals(BackendChoice.AUTO, store.backend())

        store.file.writeText("{\"other\":true}", Charsets.UTF_8)
        assertEquals(BackendChoice.AUTO, store.backend())
    }

    @Test
    fun `parse accepts the document it writes and ignores extra keys`() {
        val store = SettingsStore(temp.root)
        assertEquals(BackendChoice.NPU, store.parse("""{"version":1,"embedding":{"backend":"npu","future":1},"extra":[]}"""))
        assertEquals(BackendChoice.AUTO, store.parse(null))
        assertEquals(BackendChoice.AUTO, store.parse("   "))
    }
}
