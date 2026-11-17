package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * One visible OCR line: the words in reading order joined by single spaces, plus that line's own
 * confidence (never an average over the frame).
 *
 * ML Kit's bundled text recognition returns the tree but no per-line score (the `Text.Line` API has
 * no confidence); the seam therefore lets a reader carry one when it has it and otherwise uses
 * [ScanSignal.OCR_CONFIDENCE]. The scan screen only ever sees per-line values.
 */
data class OcrLine(
    val text: String,
    val confidence: Float = ScanSignal.OCR_CONFIDENCE,
) {
    init {
        require(confidence in 0f..1f) { "confidence must be 0..1, was $confidence" }
    }
}

/**
 * Turns one frame's OCR lines into **one text signal per line** (card B4 + B4-sync).
 *
 * `shared/spec/RANK.md` §2.2 ("Text/OCR source") mandates: *each OCR line is its own text query*
 * (`queryPrefix + trim(line)`, the line being the visible words in reading order joined by single
 * spaces), and at most 16 text query vectors per tick. Joining lines into one string is therefore
 * gone; the ranker takes the max over pooled queries, never an average, and it — not this class —
 * owns the final barcode+OCR pool cap (rank lives in B3's `decideTop`, screen wiring in B5).
 *
 * What this batcher still does, per line and in detection order:
 *  - collapses internal whitespace and trims (`WHITESPACE` → one space),
 *  - drops lines shorter than [minChars] (punctuation, box edges, single letters: noise),
 *  - truncates a single over-long line to [maxChars] (the embedder's own limit is far later),
 *  - suppresses a line whose identical text was emitted within [repeatWindowMs] (same product held
 *    still must not re-rank 30x per second); duplicates within one frame fall out of the same rule,
 *  - keeps at most [maxLinesPerFrame] lines, dropping the extras in detection order.
 *
 * Pure Kotlin, no Android: unit-tested with fake line lists and a fake timeline.
 */
class OcrLineBatcher(
    private val repeatWindowMs: Long = DEFAULT_REPEAT_WINDOW_MS,
    private val minChars: Int = DEFAULT_MIN_CHARS,
    private val maxChars: Int = DEFAULT_MAX_CHARS,
    private val maxLinesPerFrame: Int = MAX_LINES_PER_FRAME,
) {
    init {
        require(repeatWindowMs > 0) { "repeatWindowMs must be > 0" }
        require(minChars >= 1) { "minChars must be >= 1" }
        require(maxChars >= minChars) { "maxChars must be >= minChars" }
        require(maxLinesPerFrame >= 1) { "maxLinesPerFrame must be >= 1" }
    }

    private val lastEmitMs = HashMap<String, Long>()

    /**
     * The line signals due for this frame, in detection order (possibly empty). Confidence is
     * carried per line, untouched by batching.
     */
    fun batch(lines: List<OcrLine>, nowMs: Long = 0L): List<OcrLine> {
        if (lines.isEmpty()) return emptyList()
        val out = ArrayList<OcrLine>(minOf(lines.size, maxLinesPerFrame))

        for (line in lines) {
            if (out.size >= maxLinesPerFrame) break
            val text = line.text.replace(WHITESPACE, " ").trim()
            if (text.length < minChars) continue

            val normalised = if (text.length > maxChars) text.take(maxChars) else text
            val last = lastEmitMs[normalised]
            if (last != null && nowMs - last < repeatWindowMs) continue

            lastEmitMs[normalised] = nowMs
            out += OcrLine(normalised, line.confidence)
        }

        prune(nowMs)
        return out
    }

    fun reset() = lastEmitMs.clear()

    /** Keep the map bounded on a long scan session: entries older than the window cannot suppress. */
    private fun prune(nowMs: Long) {
        if (lastEmitMs.size < PRUNE_THRESHOLD) return
        lastEmitMs.entries.removeAll { nowMs - it.value >= repeatWindowMs }
    }

    companion object {
        /** A line held still is re-emitted at most every 1.5 s. */
        const val DEFAULT_REPEAT_WINDOW_MS = 1_500L
        const val DEFAULT_MIN_CHARS = 2

        /** Per line, not per frame: this is a single query string. */
        const val DEFAULT_MAX_CHARS = 240

        /**
         * RANK.md §2.2: at most 16 text query vectors per tick, extras dropped in detection order.
         * The OCR source caps itself at 16 here; the final barcode+OCR pool cap is enforced by the
         * ranker (`dev.hajnina.scanlist.kotlin.rank.RANK_MAX_TEXT_QUERIES`, B3).
         */
        const val MAX_LINES_PER_FRAME = 16

        private const val PRUNE_THRESHOLD = 64
        private val WHITESPACE = Regex("\\s+")
    }
}
