package dev.hajnina.scanlist.kotlin.scan.ui

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * The session-scoped query-vector cache (card B5): OCR re-emits the same lines every 1.5 s, so the
 * same text must only hit the native embedder once, while the cache stays bounded and forgets the
 * least recently used line first.
 */
class QueryVectorCacheTest {

    private val one = axis(0)
    private val two = axis(1)
    private val three = axis(2)

    @Test
    fun `a miss is null and a put gets the same vector back`() {
        val cache = QueryVectorCache(maxEntries = 4)
        assertNull(cache.get("Milk"))
        cache.put("Milk", one)
        assertSame(one, cache.get("Milk"))
        assertEquals(1, cache.size)
    }

    @Test
    fun `eviction drops the least recently used entry, not the oldest inserted`() {
        val cache = QueryVectorCache(maxEntries = 2)
        cache.put("a", one)
        cache.put("b", two)
        // Touch "a" so "b" becomes the least recently used.
        assertSame(one, cache.get("a"))
        cache.put("c", three)
        assertEquals(2, cache.size)
        assertSame(one, cache.get("a"))
        assertNull("b was least recently used", cache.get("b"))
        assertSame(three, cache.get("c"))
    }

    @Test
    fun `access order survives overflow and clear empties it`() {
        val cache = QueryVectorCache(maxEntries = 2)
        cache.put("a", one)
        cache.put("b", two)
        cache.put("c", three) // evicts "a"
        assertNull(cache.get("a"))
        assertArrayEquals(two, cache.get("b"), 0.0)
        assertArrayEquals(three, cache.get("c"), 0.0)
        cache.clear()
        assertEquals(0, cache.size)
        assertNull(cache.get("b"))
    }

    @Test
    fun `the default is the documented 64 entries`() {
        assertEquals(64, QueryVectorCache.DEFAULT_MAX_ENTRIES)
        val cache = QueryVectorCache()
        for (i in 0 until QueryVectorCache.DEFAULT_MAX_ENTRIES) cache.put("q$i", one)
        assertEquals(QueryVectorCache.DEFAULT_MAX_ENTRIES, cache.size)
        cache.put("overflow", two)
        assertEquals(QueryVectorCache.DEFAULT_MAX_ENTRIES, cache.size)
        assertNull("q0 is the eldest", cache.get("q0"))
    }
}
