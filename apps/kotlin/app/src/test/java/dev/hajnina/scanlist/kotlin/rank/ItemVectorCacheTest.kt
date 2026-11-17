package dev.hajnina.scanlist.kotlin.rank

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * RANK.md §2.1 cache key + card B3's disk requirements: one file per docText, exact float64
 * round-trip, readable across an app restart (a new cache instance on the same directory), and every
 * miss/corruption path degrades to "embed it again" instead of throwing.
 *
 * The two published keys below were computed with `shared/ref/scanlist_ref.py`'s
 * `item_vector_cache_key()` for the fixture's model, dims and active doc prefix — pinning the recipe
 * from the Python oracle, not from this implementation.
 */
class ItemVectorCacheTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val model = "embeddinggemma-2-740m"
    private val prefix = "task: search result | text: "

    private fun cache(dir: File = temp.newFolder("vectors")) = ItemVectorCache(
        dir = dir,
        modelId = model,
        dims = 256,
        docPrefix = prefix,
        prefixSet = "mnemothera",
    )

    @Test
    fun `key is the normative sha1 of salt, model, dims, prefix and docText`() {
        val cache = cache()
        assertEquals(
            "35b16a28b332d0c7ca4570d6a5b416567b44ce57",
            cache.key("Bananas; Fresh > Fruit & veg"),
        )
        assertEquals("a78521e88c31a6edbf856d8a0076a25d41ebdae7", cache.key("Milk"))
        assertEquals(40, cache.key("Milk").length)
        assertEquals(cache.key("Milk").lowercase(), cache.key("Milk"))
    }

    @Test
    fun `model, dims or prefix change invalidates every key`() {
        val base = cache()
        val otherModel = ItemVectorCache(base.dir, "other-model", 256, prefix)
        val otherDims = ItemVectorCache(base.dir, model, 128, prefix)
        val otherPrefix = ItemVectorCache(base.dir, model, 256, "task: document | text: ")
        assertFalse(base.key("Milk") == otherModel.key("Milk"))
        assertFalse(base.key("Milk") == otherDims.key("Milk"))
        assertFalse(base.key("Milk") == otherPrefix.key("Milk"))
        // The modelcard/doc variant of the same docText is a different entry (prefix A/B safe).
        assertEquals("0e45abe2b6b65725c8f49ff6ac4463ff9d38264f", otherPrefix.key("Bananas; Fresh > Fruit & veg"))

        base.put("Milk", unit(1.0))
        assertNull("another model must not read it", otherModel.get("Milk"))
        assertNull("another prefix set must not read it", otherPrefix.get("Milk"))
    }

    @Test
    fun `round-trips float64 bit for bit and survives a restart`() {
        val dir = temp.newFolder("vectors")
        val first = cache(dir)
        val vector = DoubleArray(256) { i -> (i + 1).toDouble() / 257.0 }
        vector[0] = 0.1 + 0.2 // 0.30000000000000004: float32 would lose this
        assertTrue(first.put("Bananas; Fresh > Fruit & veg", vector))

        assertArrayEquals("same instance (hot layer)", vector, first.get("Bananas; Fresh > Fruit & veg")!!, 0.0)

        val restarted = cache(dir) // a fresh instance = a new process on the same files
        assertArrayEquals("after restart", vector, restarted.get("Bananas; Fresh > Fruit & veg")!!, 0.0)
        assertTrue(restarted.contains("Bananas; Fresh > Fruit & veg"))
        assertEquals(1, restarted.size())
        assertTrue(
            "only the .vec file and nothing else is left behind",
            dir.listFiles()!!.none { it.name.endsWith(".tmp") },
        )
    }

    @Test
    fun `a corrupt or foreign file is a miss, never a crash`() {
        val dir = temp.newFolder("vectors")
        val cache = cache(dir)
        cache.put("Milk", unit(1.0))
        val file = cache.fileFor("Milk")
        assertTrue(file.isFile)
        file.writeBytes(byteArrayOf(0x00, 0x01, 0x02))

        // A restart (fresh instance, same dir) is the case that matters: the hot layer is gone.
        val restarted = cache(dir)
        assertNull(restarted.get("Milk"))
        assertFalse("the unreadable entry is removed so it gets rewritten", file.isFile)
        assertTrue(restarted.put("Milk", unit(1.0)))
        assertTrue(restarted.contains("Milk"))
    }

    @Test
    fun `invalid vectors are never stored`() {
        val cache = cache()
        assertFalse("wrong dims", cache.put("Milk", DoubleArray(3)))
        val nan = unit(1.0)
        nan[7] = Double.NaN
        assertFalse("NaN", cache.put("Milk", nan))
        assertFalse(cache.contains("Milk"))
    }

    @Test
    fun `clear drops every vector`() {
        val cache = cache()
        cache.put("Milk", unit(1.0))
        cache.put("Bread", unit(2.0))
        assertEquals(2, cache.size())
        cache.clear()
        assertEquals(0, cache.size())
        assertNull(cache.get("Milk"))
    }

    private fun unit(seed: Double): DoubleArray = DoubleArray(256) { i -> if (i == 0) seed else 0.0 }
}
