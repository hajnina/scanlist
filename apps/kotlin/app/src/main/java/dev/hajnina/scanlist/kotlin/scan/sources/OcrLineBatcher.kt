package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * Turns one frame's OCR lines into ONE text signal, with repeat suppression (card B4: "OCR line
 * batching").
 *
 * ML Kit returns a tree of blocks/lines/words; the scan screen wants a query string, not a tree.
 * This batcher:
 *  - trims and collapses whitespace in every line,
 *  - drops lines shorter than [minChars] (punctuation, box edges, single letters: pure noise),
 *  - de-duplicates identical lines within the frame (a product name often appears twice),
 *  - joins with `" | "` so word boundaries survive (the embedding model sees a bag of words anyway),
 *  - caps the result at [maxChars] without splitting a line,
 *  - returns null when nothing new is visible: the same text within [repeatWindowMs] is suppressed
 *    so a stationary product does not re-rank 30x per second.
 *
 * Pure Kotlin, no Android: unit-tested with fake line lists and a fake timeline.
 */
class OcrLineBatcher(
    private val repeatWindowMs: Long = DEFAULT_REPEAT_WINDOW_MS,
    private val minChars: Int = DEFAULT_MIN_CHARS,
    private val maxChars: Int = DEFAULT_MAX_CHARS,
) {
    init {
        require(repeatWindowMs > 0) { "repeatWindowMs must be > 0" }
        require(minChars >= 1) { "minChars must be >= 1" }
        require(maxChars >= minChars) { "maxChars must be >= minChars" }
    }

    private var lastText: String? = null
    private var lastEmitMs: Long = Long.MIN_VALUE

    /** The batched text to emit, or null when this frame adds nothing (empty or still suppressed). */
    fun batch(lines: List<String>, nowMs: Long = 0L): String? {
        val normalised = lines
            .map { it.replace(WHITESPACE, " ").trim() }
            .filter { it.length >= minChars }
            .distinct()

        val joined = buildString {
            for (line in normalised) {
                if (isEmpty()) {
                    append(line.take(maxChars))
                } else {
                    val candidate = "$this | $line"
                    if (candidate.length > maxChars) break
                    append(" | ").append(line)
                }
                if (length >= maxChars) break
            }
        }
        if (joined.isEmpty()) return null

        val previous = lastText
        if (previous != null && previous == joined && nowMs - lastEmitMs < repeatWindowMs) {
            return null
        }
        lastText = joined
        lastEmitMs = nowMs
        return joined
    }

    fun reset() {
        lastText = null
        lastEmitMs = Long.MIN_VALUE
    }

    companion object {
        /** A product held still is re-emitted at most every 1.5 s. */
        const val DEFAULT_REPEAT_WINDOW_MS = 1_500L
        const val DEFAULT_MIN_CHARS = 2

        /** Query text stays small: the embedder truncates far later than this anyway. */
        const val DEFAULT_MAX_CHARS = 240
        private val WHITESPACE = Regex("\\s+")
    }
}
