package dev.hajnina.scanlist.kotlin.scan.ui

/**
 * Bounded LRU of query vectors, keyed by the raw query text (card B5).
 *
 * OCR re-emits the same lines every 1.5 s and the barcode's OFF name stays for the whole pass; at
 * 2.5 frames/s that would be several native embeds per second for text the model has already seen.
 * One cache per scan session, cleared when the session ends — query text is a *runtime* thing, so
 * nothing is written to disk (only item documents are cached, card B3).
 *
 * Access-ordered [LinkedHashMap] (the `true` flag) gives O(1) LRU without a dependency.
 */
class QueryVectorCache(private val maxEntries: Int = DEFAULT_MAX_ENTRIES) {

    init {
        require(maxEntries >= 1) { "maxEntries must be >= 1" }
    }

    private val map = object : LinkedHashMap<String, DoubleArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, DoubleArray>): Boolean =
            size > maxEntries
    }

    fun get(text: String): DoubleArray? = map[text]

    fun put(text: String, vec: DoubleArray) {
        map[text] = vec
    }

    val size: Int get() = map.size

    fun clear() = map.clear()

    companion object {
        /** One product's worth of OCR lines with headroom (16 queries/tick max). */
        const val DEFAULT_MAX_ENTRIES = 64
    }
}
