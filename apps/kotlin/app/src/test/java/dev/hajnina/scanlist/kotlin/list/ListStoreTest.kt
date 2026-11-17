package dev.hajnina.scanlist.kotlin.list

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Persistence contract (LIST.md §7): the stored file IS the export format; ticks survive a reload. */
class ListStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var root: File
    private lateinit var repository: ListRepository

    @Before
    fun setUp() {
        root = temp.newFolder("files")
        repository = ListRepository(ListStore(root))
    }

    @Test
    fun `import writes one list file that is exactly the export format`() {
        val result = repository.import(Samples.read("van-weekly.json"))
        val stored = (result as ImportResult.Ok).stored
        assertEquals("van-weekly-shop", stored.id)

        val file = File(File(root, "lists"), "van-weekly-shop.json")
        assertTrue("stored file missing", file.isFile)

        // The file on disk parses back to the imported model and equals the export byte for byte.
        val onDisk = file.readText(Charsets.UTF_8).trim()
        assertEquals(ListJson.encode(stored.list).trim(), onDisk)
        assertEquals(stored.list, parse(onDisk))
    }

    @Test
    fun `every shared sample imports, persists and reloads equal`() {
        Samples.requireAll().forEach { (name, text) ->
            val imported = repository.import(text)
            val stored = (imported as? ImportResult.Ok)?.stored ?: error("$name failed: $imported")
            val reloaded = ListRepository(ListStore(root)).loadAll().first { it.id == stored.id }
            assertEquals("$name reload", stored.list, reloaded.list)
            assertEquals("$name export", ListJson.encode(stored.list), ListJson.encode(reloaded.list))
        }
        assertEquals(4, repository.loadAll().size)
    }

    @Test
    fun `ticking persists across a fresh store instance`() {
        val stored = (repository.import(Samples.read("van-weekly.json")) as ImportResult.Ok).stored
        val bananas = stored.list.flatten().first { it.name == "Bananas" }
        val ticked = repository.toggle(stored.id, bananas.id)
        assertNotNull(ticked)
        assertTrue(ticked!!.flatten().first { it.name == "Bananas" }.done)

        val reloaded = ListRepository(ListStore(root)).get(stored.id)!!.list
        assertEquals(ticked, reloaded)
        assertEquals(1, reloaded.tickedCount())

        // Untick persists too.
        repository.toggle(stored.id, bananas.id)
        assertEquals(0, ListRepository(ListStore(root)).get(stored.id)!!.list.tickedCount())
    }

    @Test
    fun `ticking one list does not touch another`() {
        val a = (repository.import(Samples.read("van-weekly.json")) as ImportResult.Ok).stored
        val b = (repository.import(Samples.read("string-amounts.json")) as ImportResult.Ok).stored
        val item = a.list.flatten().first()
        repository.toggle(a.id, item.id)

        val bReloaded = ListRepository(ListStore(root)).get(b.id)!!.list
        assertEquals(b.list, bReloaded)
        assertEquals(1, bReloaded.tickedCount()) // only the sample's own ticked Ice cream
    }

    @Test
    fun `export after ticking round-trips through import`() {
        val stored = (repository.import(Samples.read("deep-nesting.json")) as ImportResult.Ok).stored
        val cumin = stored.list.flatten().first { it.name == "Cumin" }
        repository.toggle(stored.id, cumin.id)

        val json = repository.exportJson(stored.id)!!
        assertTrue(json, json.contains("\"done\": true"))
        val reimported = (repository.import(json) as ImportResult.Ok).stored
        assertEquals(repository.get(stored.id)!!.list, reimported.list)
        // Done flags and order survive: 2 originally ticked + Cumin.
        assertEquals(3, reimported.list.tickedCount())
        assertEquals(
            repository.get(stored.id)!!.list.flatten().map { it.name to it.done },
            reimported.list.flatten().map { it.name to it.done },
        )
    }

    @Test
    fun `importing the same list twice creates two independent lists`() {
        val first = (repository.import(Samples.read("van-weekly.json")) as ImportResult.Ok).stored
        val second = (repository.import(Samples.read("van-weekly.json")) as ImportResult.Ok).stored
        assertEquals("van-weekly-shop", first.id)
        assertEquals("van-weekly-shop-2", second.id)
        assertEquals(first.list, second.list)

        repository.toggle(first.id, first.list.flatten().first().id)
        assertEquals(0, repository.get(second.id)!!.list.tickedCount())
    }

    @Test
    fun `invalid imports persist nothing and report pointers`() {
        val before = repository.loadAll().size
        val result = repository.import("""{"title":"T","sections":[{"name":"S","items":[{"amount":2}]}]}""")
        val errors = (result as ImportResult.Invalid).errors
        assertTrue(errors.single().startsWith("/sections/0/items/0/name"))
        assertEquals(before, repository.loadAll().size)
        assertTrue(File(root, "lists").let { !it.exists() || it.listFiles()!!.isEmpty() })
    }

    @Test
    fun `delete removes the file`() {
        val stored = (repository.import("""{"title":"Tmp","sections":[]}""") as ImportResult.Ok).stored
        assertTrue(repository.delete(stored.id))
        assertNull(repository.get(stored.id))
        assertEquals(emptyList<StoredList>(), repository.loadAll())
    }

    @Test
    fun `corrupt files are skipped, not crashed on`() {
        val stored = (repository.import(Samples.read("van-weekly.json")) as ImportResult.Ok).stored
        File(File(root, "lists"), "broken.json").writeText("{ not json", Charsets.UTF_8)
        val lists = repository.loadAll()
        assertEquals(listOf(stored.id), lists.map { it.id })
    }

    @Test
    fun `save is atomic - no temp file left behind`() {
        val stored = (repository.import(Samples.read("van-weekly.json")) as ImportResult.Ok).stored
        repository.toggle(stored.id, stored.list.flatten().first().id)
        val leftovers = File(root, "lists").listFiles()!!.filter { it.name.endsWith(".tmp") }
        assertEquals(emptyList<File>(), leftovers)
    }

    @Test
    fun `list ids are filesystem safe`() {
        val stored = (repository.import("""{"title":"../../../etc/passwd","sections":[]}""") as ImportResult.Ok).stored
        val store = ListStore(root)
        assertTrue(store.isValidId(stored.id))
        assertFalse(stored.id.contains("/"))
        assertFalse(stored.id.contains(".."))
    }

    @Test
    fun `ids are unique slugs with numeric suffixes`() {
        val store = ListStore(root)
        val repo = ListRepository(store)
        val ids = (1..3).map { (repo.import("""{"title":"Semana checa","sections":[]}""") as ImportResult.Ok).stored.id }
        assertEquals(listOf("semana-checa", "semana-checa-2", "semana-checa-3"), ids)
    }

    private fun parse(text: String): ScanList =
        when (val result = ListJson.parse(text)) {
            is ListJson.ParseResult.Ok -> result.list
            is ListJson.ParseResult.Invalid -> error("parse failed: ${result.errors}")
        }
}
