package dev.hajnina.scanlist.kotlin.scan.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * OFF.md §4: the barcode → product-text cache. Positive hits live 30 days, misses 1 day, an answer
 * at exactly the TTL is expired, a backward clock clamps to "just fetched", and the file survives a
 * restart (this is the offline story: a known barcode ranks without a network).
 */
class OffCacheTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun cache(file: File = File(temp.newFolder("off"), "cache.json")) = OffCache(file)

    @Test
    fun `a hit is fresh for 30 days and a miss for 1 day, boundary excluded`() {
        val hit = OffCache.Entry("Nutella", hit = true, fetchedAt = 1_000)
        assertTrue(hit.fresh(1_000))
        assertTrue(hit.fresh(1_000 + OffCache.HIT_TTL_SECONDS - 1))
        assertFalse("exactly the TTL is expired", hit.fresh(1_000 + OffCache.HIT_TTL_SECONDS))
        assertEquals(OffCache.HIT_TTL_SECONDS, hit.ttlSeconds())

        val miss = OffCache.Entry(null, hit = false, fetchedAt = 1_000)
        assertTrue(miss.fresh(1_000 + OffCache.MISS_TTL_SECONDS - 1))
        assertFalse(miss.fresh(1_000 + OffCache.MISS_TTL_SECONDS))
        assertEquals(OffCache.MISS_TTL_SECONDS, miss.ttlSeconds())
    }

    @Test
    fun `a hit without usable text is still cached for 30 days`() {
        val store = cache()
        store.put("11111111", text = null, hit = true, nowSeconds = 0)
        val entry = store.get("11111111", nowSeconds = OffCache.HIT_TTL_SECONDS - 1)!!
        assertNull(entry.text)
        assertTrue(entry.hit)
        assertFalse(store.get("11111111", OffCache.HIT_TTL_SECONDS)!!.fresh(OffCache.HIT_TTL_SECONDS))
    }

    @Test
    fun `the age clamps to zero when the wall clock moves backwards`() {
        val store = cache()
        store.put("11111111", "Nutella", hit = true, nowSeconds = 10_000)
        val entry = store.get("11111111", nowSeconds = 5_000)!!
        assertEquals(0L, entry.ageSeconds(5_000))
        assertTrue("a wrong clock must not throw the cache away", entry.fresh(5_000))
    }

    @Test
    fun `an unknown barcode is a miss and a stored one comes back verbatim`() {
        val store = cache()
        assertNull(store.get("99999999", nowSeconds = 0))
        store.put("3017620422003", "Nutella", hit = true, nowSeconds = 100)
        val first = store.get("3017620422003", nowSeconds = 200)!!
        assertEquals("Nutella", first.text)
        assertTrue(first.hit)
        assertEquals(100L, first.fetchedAt)
        assertEquals("the returned entry is the stored one", 100L, first.usedAt)
        assertEquals("the read refreshes usedAt in memory", 200L, store.get("3017620422003", nowSeconds = 300)!!.usedAt)
        assertEquals(1, store.size)
    }

    @Test
    fun `entries survive a restart on the same file`() {
        val file = File(temp.newFolder("off"), "cache.json")
        val first = cache(file)
        first.put("3017620422003", "Nutella", hit = true, nowSeconds = 500)
        first.put("3245390098214", text = null, hit = false, nowSeconds = 500)
        assertTrue(file.isFile)

        val second = OffCache(file)
        val hit = second.get("3017620422003", nowSeconds = 600)!!
        assertEquals("Nutella", hit.text)
        assertTrue(hit.hit)
        assertEquals(500L, hit.fetchedAt)
        val miss = second.get("3245390098214", nowSeconds = 600)!!
        assertNull(miss.text)
        assertFalse(miss.hit)
        assertEquals(2, second.size)
    }

    @Test
    fun `a corrupted cache file degrades to an empty cache instead of crashing`() {
        val file = File(temp.newFolder("off"), "cache.json")
        file.parentFile.mkdirs()
        file.writeText("{not json", Charsets.UTF_8)
        val store = OffCache(file)
        assertNull(store.get("3017620422003", nowSeconds = 0))
        store.put("3017620422003", "Nutella", hit = true, nowSeconds = 1)
        val repaired = file.readText()
        assertFalse("the next write repairs the file", repaired.contains("not json"))
        assertTrue(repaired.contains("Nutella"))
    }

    @Test
    fun `remove and clear are persisted`() {
        val file = File(temp.newFolder("off"), "cache.json")
        val store = cache(file)
        store.put("11111111", "Milk", hit = true, nowSeconds = 0)
        store.put("22222222", "Bread", hit = true, nowSeconds = 0)
        assertTrue(store.remove("11111111"))
        assertFalse(store.remove("11111111"))
        assertEquals(1, store.size)
        val reloaded = OffCache(file)
        assertNull(reloaded.get("11111111", nowSeconds = 0))
        assertEquals("Bread", reloaded.get("22222222", nowSeconds = 0)!!.text)

        store.clear()
        assertEquals(0, store.size)
        val cleared = OffCache(file)
        assertNull(cleared.get("22222222", nowSeconds = 1))
        assertEquals(0, cleared.size)
    }

    @Test
    fun `the cache is capped - expired entries first, then the least recently used`() {
        val store = cache()
        // Fill to the cap with entries that are already expired at "now".
        val now = OffCache.HIT_TTL_SECONDS * 2
        for (i in 0 until OffCache.MAX_ENTRIES) {
            store.put("old$i", "x", hit = true, nowSeconds = 0)
        }
        assertEquals(OffCache.MAX_ENTRIES, store.size)
        store.put("new", "Milk", hit = true, nowSeconds = now)
        assertEquals(OffCache.MAX_ENTRIES, store.size)
        assertNotNull(store.get("new", nowSeconds = now))
        assertNull("one expired entry was reclaimed", store.get("old0", nowSeconds = now))
    }

    @Test
    fun `all fresh entries evict the least recently used when over the cap`() {
        val store = cache()
        for (i in 0 until OffCache.MAX_ENTRIES) {
            store.put("${100_000_000_0000L + i}", "x", hit = true, nowSeconds = 0)
        }
        store.put("fresh-favourite", "Milk", hit = true, nowSeconds = 1)
        assertEquals(OffCache.MAX_ENTRIES, store.size)
        assertNotNull(store.get("fresh-favourite", nowSeconds = 1))
        assertNull("the first inserted is the eldest", store.get("1000000000000", nowSeconds = 1))
    }

    @Test
    fun `the standard location is filesDir off cache json`() {
        val filesDir = temp.newFolder("files")
        val store = OffCache.forFilesDir(filesDir)
        store.put("11111111", "Milk", hit = true, nowSeconds = 0)
        assertTrue(File(File(filesDir, "off"), "cache.json").isFile)
    }
}
