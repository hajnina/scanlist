package dev.hajnina.scanlist.kotlin.rank

// Cache-aware item embedding (card B3): "embed this list's items, reusing whatever the disk cache
// already has". Pure Kotlin + java.io so the JVM tests can drive it with a temp dir and a fake
// [VectorSource]; the Android background/Compose layer lives in ListEmbedding.kt.

/** One item to embed: its id and its FLATTEN.md §4 `docText` (the cache key input). */
data class ItemDoc(val id: String, val docText: String)

/** Progress of one embedding pass, reported after every batch (and once when it starts). */
data class EmbedProgress(
    val total: Int,
    val done: Int,
    val fromCache: Int,
    val embedded: Int,
    val failed: Int,
) {
    /** 0..1 for a progress bar; 1 when there is nothing to do. */
    val fraction: Float get() = if (total <= 0) 1f else done.toFloat() / total

    val complete: Boolean get() = done >= total
}

/**
 * The vectors of one list, keyed by item id, plus what could not be embedded. Items sharing a
 * docText share one vector (and one cache entry).
 */
class ItemVectors(
    val byId: Map<String, DoubleArray>,
    val docTextById: Map<String, String>,
    val failed: List<String>,
) {
    operator fun get(id: String): DoubleArray? = byId[id]

    val size: Int get() = byId.size

    /** True when every item got a vector — what RANK.md §8 needs before it will evaluate a tick. */
    val complete: Boolean get() = failed.isEmpty() && byId.size == docTextById.size
}

/**
 * Embeds item docs into [cache], in batches, reporting progress (card B3: "embed items on open,
 * background, progress").
 *
 * Blocking on purpose: the caller decides where it runs (the app uses `Dispatchers.IO`, a JVM test
 * calls it inline). Cache hits cost a file read and never touch the model; only the misses are sent
 * to [source], in [batchSize] batches, so the first list open of a session is one model load plus
 * ceil(items/batchSize) native calls.
 */
class ItemVectorIndex(
    private val cache: ItemVectorCache,
    private val source: VectorSource,
    private val batchSize: Int = 8,
) {
    init {
        require(batchSize > 0) { "batchSize must be positive" }
        require(cache.dims == source.dims) {
            "cache stores ${cache.dims}-d vectors but ${source.modelId} returns ${source.dims}-d ones"
        }
    }

    val dims: Int get() = cache.dims

    /**
     * Ensure every doc has a vector. Returns by item id; items whose embedding failed are listed in
     * [ItemVectors.failed] and excluded from [ItemVectors.byId] (RANK.md §8 treats them as missing).
     *
     * [shouldStop] is polled between batches so a caller leaving the screen can abort cheaply;
     * a stopped pass returns what it has (cache-only entries included) and simply leaves the rest for
     * the next pass.
     */
    fun embed(
        docs: List<ItemDoc>,
        onProgress: (EmbedProgress) -> Unit = {},
        shouldStop: () -> Boolean = { false },
    ): ItemVectors {
        val docTextById = LinkedHashMap<String, String>(docs.size)
        for (doc in docs) docTextById[doc.id] = doc.docText

        // One vector per distinct docText: two items with the same text cost one embed and one file.
        val uniqueTexts = LinkedHashSet<String>(docs.size)
        for (doc in docs) uniqueTexts += doc.docText
        val total = uniqueTexts.size

        val vectors = HashMap<String, DoubleArray>(total)
        var hits = 0
        for (text in uniqueTexts) {
            val cached = cache.get(text)
            if (cached != null) {
                vectors[text] = cached
                hits++
            }
        }
        var embedded = 0
        val failed = ArrayList<String>()
        fun progress() = EmbedProgress(
            total = total,
            done = vectors.size,
            fromCache = hits,
            embedded = embedded,
            failed = failed.size,
        )
        onProgress(progress())

        val pending = uniqueTexts.filterNot { vectors.containsKey(it) }
        var cursor = 0
        while (cursor < pending.size) {
            if (shouldStop()) break
            val batch = pending.subList(cursor, minOf(cursor + batchSize, pending.size))
            cursor += batch.size
            val returned = source.embedDocs(batch)
            check(returned.size == batch.size) {
                "${source.modelId}: embedDocs returned ${returned.size} vectors for ${batch.size} texts"
            }
            batch.forEachIndexed { index, text ->
                val vec = returned[index]
                if (vec.size != dims || vec.any { !it.isFinite() }) {
                    failed += text
                } else {
                    vectors[text] = vec
                    cache.put(text, vec)
                    embedded++
                }
            }
            onProgress(progress())
        }

        val byId = LinkedHashMap<String, DoubleArray>(docs.size)
        val failedIds = ArrayList<String>()
        for (doc in docs) {
            val vec = vectors[doc.docText]
            if (vec == null) failedIds += doc.id else byId[doc.id] = vec
        }
        onProgress(progress())
        return ItemVectors(byId, docTextById, failedIds)
    }
}
