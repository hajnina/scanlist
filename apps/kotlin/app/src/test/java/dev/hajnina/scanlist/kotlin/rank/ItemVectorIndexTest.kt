package dev.hajnina.scanlist.kotlin.rank

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Card B3's on-open embedding path (without Android or a model): cache-aware batching, progress
 * callbacks, a restart that costs no embeddings, shared docTexts, and failures that stay failures
 * instead of poisoning the cache.
 */
class ItemVectorIndexTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val model = "embeddinggemma-2-740m"
    private val dims = 4
    private val prefix = "task: search result | text: "

    private fun cache(dir: File = temp.newFolder()) =
        ItemVectorCache(dir, model, dims, prefix)

    private fun docs(vararg text: String): List<ItemDoc> = text.mapIndexed { i, t -> ItemDoc("id$i", t) }

    @Test
    fun `embeds in batches and reports progress until complete`() {
        val dir = temp.newFolder()
        val source = FakeSource(dims = dims)
        val index = ItemVectorIndex(cache(dir), source, batchSize = 2)
        val progress = ArrayList<EmbedProgress>()

        val result = index.embed(docs("a", "b", "c", "d", "e"), onProgress = { progress += it })

        assertEquals("5 unique docs in batches of 2", 3, source.docCalls)
        assertEquals(listOf("a", "b", "c", "d", "e"), source.embeddedTexts)
        assertEquals(5, result.size)
        assertTrue(result.complete)
        assertEquals(5, result.byId.keys.size)
        assertTrue(progress.isNotEmpty())
        assertEquals(0, progress.first().done)
        assertEquals(5, progress.last().done)
        assertEquals(1.0f, progress.last().fraction, 0.0f)
        assertEquals(5, progress.last().embedded)
        assertEquals(0, progress.last().fromCache)
        assertTrue("progress is monotonic", progress.zipWithNext().all { (a, b) -> b.done >= a.done })
        // Stored, so the next open is free.
        assertEquals(5, cache(dir).size())
    }

    @Test
    fun `a restart (new cache instance, same dir) embeds nothing`() {
        val dir = temp.newFolder("vectors")
        ItemVectorIndex(cache(dir), FakeSource(dims = dims)).embed(docs("milk", "bread"))

        val restartSource = FakeSource(dims = dims, failOnCall = true)
        val progress = ArrayList<EmbedProgress>()
        val result = ItemVectorIndex(cache(dir), restartSource).embed(
            docs("milk", "bread"),
            onProgress = { progress += it },
        )

        assertEquals("no embedder call after a restart — the disk cache is hot", 0, restartSource.docCalls)
        assertTrue(result.complete)
        assertEquals(2, progress.last().fromCache)
        assertEquals(0, progress.last().embedded)
    }

    @Test
    fun `items sharing a docText share one vector and one cache entry`() {
        val dir = temp.newFolder()
        val source = FakeSource(dims = dims)
        val index = ItemVectorIndex(cache(dir), source)
        val result = index.embed(listOf(ItemDoc("one", "milk"), ItemDoc("two", "milk")))

        assertEquals(listOf("milk"), source.embeddedTexts)
        assertEquals(1, cache(dir).size())
        assertEquals(result["one"]!!.toList(), result["two"]!!.toList())
    }

    @Test
    fun `a failed vector is reported and retried, never cached`() {
        val dir = temp.newFolder("vectors")
        val source = FakeSource(dims = dims, broken = setOf("bad"))
        val first = ItemVectorIndex(cache(dir), source).embed(docs("good", "bad"))

        assertEquals(listOf("id0"), first.byId.keys.toList())
        assertEquals(listOf("id1"), first.failed)
        assertFalse(first.complete)
        assertEquals("only the good vector is on disk", 1, cache(dir).size())
        assertNull(first["id1"])

        // The retry embeds the failed doc again (the cache has no entry for it) and can succeed.
        val healed = FakeSource(dims = dims)
        val second = ItemVectorIndex(cache(dir), healed).embed(docs("good", "bad"))
        assertTrue(second.complete)
        assertEquals(listOf("bad"), healed.embeddedTexts)
        assertEquals(2, cache(dir).size())
    }

    @Test
    fun `shouldStop aborts between batches and leaves what it has`() {
        val source = FakeSource(dims = dims)
        var batches = 0
        val aborted = ItemVectorIndex(cache(), source, batchSize = 1).embed(
            docs("w", "x", "y", "z"),
            shouldStop = { batches++ > 0 },
        )
        assertEquals("one batch was embedded, then we stopped", 1, source.docCalls)
        assertEquals(1, aborted.byId.size)
        assertEquals(3, aborted.failed.size)
    }

    @Test
    fun `an embedder that breaks its contract is a hard error, not silent garbage`() {
        val wrongCount = object : VectorSource {
            override val modelId = model
            override val dims = 4
            override fun embedDocs(docTexts: List<String>) = listOf(DoubleArray(4))
            override fun embedQuery(text: String) = DoubleArray(4)
            override fun embedImage(jpeg: ByteArray) = DoubleArray(4)
        }
        val error = runCatching { ItemVectorIndex(cache(), wrongCount).embed(docs("a", "b")) }
        assertTrue("returned 1 vector for 2 texts", error.exceptionOrNull() is IllegalStateException)
    }

    /** Deterministic fake: a unit vector per docText, optional broken/failing behaviour. */
    private class FakeSource(
        override val dims: Int,
        override val modelId: String = "embeddinggemma-2-740m",
        private val broken: Set<String> = emptySet(),
        private val failOnCall: Boolean = false,
    ) : VectorSource {
        var docCalls = 0
            private set
        val embeddedTexts = ArrayList<String>()

        override fun embedDocs(docTexts: List<String>): List<DoubleArray> {
            check(!failOnCall) { "embedDocs must not be called: the cache should have been hot" }
            docCalls++
            embeddedTexts += docTexts
            return docTexts.map { text ->
                if (text in broken) {
                    DoubleArray(dims) { Double.NaN }
                } else {
                    DoubleArray(dims) { i -> if (i == (text.hashCode() and Int.MAX_VALUE) % dims) 1.0 else 0.0 }
                }
            }
        }

        override fun embedQuery(text: String): DoubleArray = DoubleArray(dims) { i -> if (i == 0) 1.0 else 0.0 }

        override fun embedImage(jpeg: ByteArray): DoubleArray = DoubleArray(dims) { i -> if (i == 0) 1.0 else 0.0 }
    }
}
