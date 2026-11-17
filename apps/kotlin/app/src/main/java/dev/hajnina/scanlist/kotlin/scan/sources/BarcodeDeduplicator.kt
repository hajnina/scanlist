package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * Suppresses the same barcode being emitted over and over (card B4: "barcode dedupe: same barcode
 * within N seconds → suppressed").
 *
 * A barcode is in view for many frames; without this the scan screen would get 30 identical
 * signals per second and re-rank for nothing. Pure: caller passes the clock reading, tests pass a
 * fake timeline. Different values never suppress each other, and a value reappears after the window.
 */
class BarcodeDeduplicator(
    private val clock: Clock = Clock.Default,
    private val windowMs: Long = DEFAULT_WINDOW_MS,
) {
    init {
        require(windowMs > 0) { "windowMs must be > 0, was $windowMs" }
    }

    private val lastSeenMs = HashMap<String, Long>()

    /** True when [value] was not emitted within the last [windowMs]; records it when it says yes. */
    fun accept(value: String, nowMs: Long = clock.nowMs()): Boolean {
        val key = value.trim()
        if (key.isEmpty()) return false
        val last = lastSeenMs[key]
        if (last != null && nowMs - last < windowMs) return false
        lastSeenMs[key] = nowMs
        prune(nowMs)
        return true
    }

    fun reset() = lastSeenMs.clear()

    /** Keep the map bounded on a long scan session: entries older than the window cannot suppress. */
    private fun prune(nowMs: Long) {
        if (lastSeenMs.size < PRUNE_THRESHOLD) return
        lastSeenMs.entries.removeAll { nowMs - it.value >= windowMs }
    }

    companion object {
        /** Long enough to cover a hand-held pause on one product, short enough to re-scan it. */
        const val DEFAULT_WINDOW_MS = 3_000L
        private const val PRUNE_THRESHOLD = 64
    }
}
