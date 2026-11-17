package dev.hajnina.scanlist.kotlin.rank

// RANK.md §7 (cadence + lifecycle), mirroring `RankTicker` in shared/ref/scanlist_ref.py (card S2).
// The ranker itself stays pure; this class owns only the state the spec assigns to the caller:
// the latest query set, one evaluation per 400 ms, and the immediate ticks for a tick/untick, a list
// change, a scan start/stop.
//
// Not thread-safe by design: call it from the thread that owns the scan session (the UI/main thread,
// or a single collector). The 400 ms clock is monotonic milliseconds supplied by the caller, so JVM
// tests can step time deterministically instead of sleeping.

/** RANK.md §7 lifecycle wrapper. `state`/`lastOutput` are the values a caller persists. */
class RankTicker(
    val minIntervalMs: Long = RANK_MIN_INTERVAL_MS,
    val dims: Int = RANK_DIMS_ACTIVE,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    init {
        require(minIntervalMs >= 0) { "minIntervalMs must be >= 0" }
        require(dims > 0) { "dims must be positive" }
    }

    /** The state returned by the last tick; what the next tick smooths from. */
    var state: RankState = RankState.EMPTY
        private set

    /** The last output; RANK.md §8 "vectors still missing" returns exactly this. */
    var lastOutput: RankResult? = null
        private set

    /** The pending query set — latest signal wins, nothing is queued (RANK.md §7). */
    var queries: RankQueries = RankQueries()
        private set

    private var lastEvalMs: Long? = null

    /**
     * Replace the pending query set; a `null` argument keeps that source unchanged (RANK.md §7: the
     * newest frame replaces the pending set, the §2.2 image window is the camera's job, not ours).
     */
    fun submit(text: List<DoubleArray>? = null, image: List<DoubleArray>? = null): RankTicker {
        if (text != null || image != null) {
            queries = RankQueries(text ?: queries.text, image ?: queries.image)
        }
        return this
    }

    /** Drop state + cached output + clock (list changed / scan start). */
    fun reset(): RankTicker {
        state = RankState.EMPTY
        lastOutput = null
        lastEvalMs = null
        return this
    }

    /** Evaluate only when the 400 ms window has elapsed; `null` means "not this frame". */
    fun tick(
        items: List<RankItem>,
        atMs: Long? = null,
        barcodeName: String? = null,
    ): RankResult? = evaluate(items, atMs, barcodeName, immediate = false)

    /** Immediate evaluation (an item was ticked/unticked); it resets the 400 ms clock. */
    fun tickNow(
        items: List<RankItem>,
        atMs: Long? = null,
        barcodeName: String? = null,
    ): RankResult = checkNotNull(evaluate(items, atMs, barcodeName, immediate = true))

    /** Add/remove/rename/amount edit: clear the state and top, then evaluate immediately. */
    fun listChanged(
        items: List<RankItem>,
        atMs: Long? = null,
        barcodeName: String? = null,
    ): RankResult {
        reset()
        return checkNotNull(evaluate(items, atMs, barcodeName, immediate = true))
    }

    /** New scan session: empty state, immediate tick once a query exists. */
    fun scanStarted(
        items: List<RankItem>,
        atMs: Long? = null,
        barcodeName: String? = null,
    ): RankResult {
        reset()
        return checkNotNull(evaluate(items, atMs, barcodeName, immediate = true))
    }

    /** Camera closed / scan stopped: unranked flatten order, state and queries cleared (§8). */
    fun scanStopped(items: List<RankItem>): RankResult {
        reset()
        queries = RankQueries()
        val output = unranked(items)
        lastOutput = output
        return output
    }

    /** The §7 gate + one tick. Public so callers that own their own clock can drive it directly. */
    fun evaluate(
        items: List<RankItem>,
        atMs: Long? = null,
        barcodeName: String? = null,
        immediate: Boolean = false,
    ): RankResult? {
        val at = atMs ?: clock()
        val previousEval = lastEvalMs
        if (!immediate && previousEval != null && at - previousEval < minIntervalMs) return null
        val output = rank(
            items = items,
            queries = queries,
            prev = state,
            barcodeName = barcodeName,
            previous = lastOutput,
            dims = dims,
        )
        lastEvalMs = at
        state = output.state
        lastOutput = output
        return output
    }
}
