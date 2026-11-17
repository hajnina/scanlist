package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.list.FlatItem
import dev.hajnina.scanlist.kotlin.rank.RANK_DIMS_ACTIVE
import dev.hajnina.scanlist.kotlin.rank.RankItem
import dev.hajnina.scanlist.kotlin.rank.RankResult
import dev.hajnina.scanlist.kotlin.rank.RankTicker
import dev.hajnina.scanlist.kotlin.rank.toRankItems
import dev.hajnina.scanlist.kotlin.scan.sources.ScanKind
import dev.hajnina.scanlist.kotlin.scan.sources.ScanSignal

/**
 * The heart of the magic scan (card B5): live scan signals → query vectors → `RankTicker` → the view
 * the screen renders. It never decides a highlight itself — `rank()`/`decideTop` (card B3/S10) own
 * that, including the hysteresis, the per-source gates and the image accept-list. This class only
 * decides **what is a query** (pool order, TTLs, rotation) and **what the honest UI state is**.
 *
 * Threading: synchronous, no coroutines, no Android. The Compose layer calls it on a single worker
 * (embedding is blocking native work) and stores the returned [ScanView] as Compose state; the JVM
 * tests call it inline with a fake embedder and fake clock.
 *
 * Lifecycle (RANK.md §7, mirrored by [RankTicker]):
 *  - [start] opens a scan session (state + queries cleared, immediate tick),
 *  - [items] reports a list/vector change (`listChanged`),
 *  - [signal] one live signal; [barcodeText] the OFF answer that belongs to a barcode,
 *  - [commit] a tick just happened: one product, one tick — the hero waits for the next signal,
 *  - [stop] the camera is gone: unranked flatten order, everything forgotten.
 */
class ScanSession(
    private val embedder: QueryEmbedder,
    private val rotator: ImageRotator = ImageRotator.NONE,
    private val ticker: RankTicker = RankTicker(dims = RANK_DIMS_ACTIVE),
    private val pool: SignalPool = SignalPool(),
    private val queryCache: QueryVectorCache = QueryVectorCache(),
    private val liveness: SourceLiveness = SourceLiveness(),
    private val dims: Int = RANK_DIMS_ACTIVE,
) {
    init {
        require(embedder.dims == dims) {
            "embedder returns ${embedder.dims}-d vectors but the ranker runs at $dims dims"
        }
    }

    /** The last rendered view; Compose reads this through the controller. */
    var view: ScanView = ScanView.INITIAL
        private set

    private var nowMs: Long = 0L
    private var flat: List<FlatItem> = emptyList()
    private var rankItems: List<RankItem> = emptyList()

    /** Latest upright frame vector; replaced by every new IMAGE signal (RANK.md §7 latest wins). */
    private var imageQuery: DoubleArray? = null

    /**
     * False between a tick and the *next product*: one product, one decision per scan pass.
     *
     * A new barcode or an OCR line the committed pass did not see re-arms the hero; another frame of
     * the same still product does not. This is Barcode Buddy's "auto-revert after one tick" without a
     * timer (the lead's digest note): the big tick cannot immediately land on a second item that the
     * camera merely *sees*, and moving to another product brings the hero back on the first new word.
     */
    private var armed = true

    private var committedBarcode: String? = null

    private var lastResult: RankResult? = null

    /** The barcode of the current pass (OFF.md §4 cache key), or null. */
    val barcode: String? get() = pool.barcode

    /** The text queries this tick will embed, barcode first (test seam + debug readout). */
    val pendingTextQueries: List<String> get() = pool.textQueries(nowMs)

    /** Scan session opened (camera bound): previous queries and ranking state are discarded. */
    fun start(items: List<FlatItem>, vectors: Map<String, DoubleArray>?, nowMs: Long): ScanView {
        this.nowMs = nowMs
        flat = items
        rankItems = items.toRankItems(vectors)
        pool.clear()
        queryCache.clear()
        liveness.clear()
        imageQuery = null
        armed = true
        committedBarcode = null
        // A new session starts with no query at all: the ticker keeps its pending set across ticks,
        // so without this an immediate tick would rank the new session by the previous pass's words.
        ticker.submit(text = emptyList(), image = emptyList())
        lastResult = ticker.scanStarted(rankItems, nowMs, pool.barcodeText)
        view = render(lastResult!!, nowMs)
        return view
    }

    /** The list (or its item vectors) changed: re-rank from the current queries, immediately. */
    fun items(items: List<FlatItem>, vectors: Map<String, DoubleArray>?, nowMs: Long): ScanView {
        this.nowMs = nowMs
        flat = items
        rankItems = items.toRankItems(vectors)
        lastResult = ticker.listChanged(rankItems, nowMs, pool.barcodeText)
        view = render(lastResult!!, nowMs)
        return view
    }

    /**
     * One live signal. TEXT lines and barcodes join the pool; an IMAGE frame is rotated upright
     * (card B5's sensor-orientation decision) and embedded, replacing the previous frame's vector.
     * Then the 400 ms rank gate decides whether this signal produces a new evaluation.
     */
    fun signal(signal: ScanSignal, nowMs: Long = signal.emittedAtMs): ScanView {
        this.nowMs = nowMs
        when (signal.kind) {
            ScanKind.BARCODE -> {
                val digits = signal.text?.trim()
                if (!digits.isNullOrEmpty()) {
                    pool.acceptBarcode(digits, nowMs)
                    // A different product re-arms the hero; the one just ticked does not.
                    if (!armed && digits != committedBarcode) armed = true
                }
                liveness.fire(ScanKind.BARCODE, nowMs)
            }
            ScanKind.TEXT -> {
                val line = signal.text?.trim()
                if (!line.isNullOrEmpty()) {
                    val isNew = !pool.knowsOcr(line)
                    pool.acceptOcr(line, nowMs)
                    if (!armed && isNew) armed = true
                }
                liveness.fire(ScanKind.TEXT, nowMs)
            }
            ScanKind.IMAGE -> {
                // A frame alone never re-arms: a still camera would otherwise re-point the hero at a
                // different list item every 400 ms after the tick.
                liveness.fire(ScanKind.IMAGE, nowMs)
                pool.noteImage(nowMs)
                embedImage(signal)
            }
        }
        rankNow(nowMs, immediate = false)
        return view
    }

    /**
     * OFF.md §3 resolved (or unresolvable) product text for the current barcode. `null` is a valid
     * outcome — a miss, an empty name or a transient failure all mean "no barcode text this tick" —
     * and it still wakes the ranker so the barcode chip's story is rendered immediately.
     */
    fun barcodeText(text: String?, forBarcode: String? = null, nowMs: Long = this.nowMs): ScanView {
        // An answer that arrives after the user moved to another product belongs to nobody.
        if (forBarcode != null && forBarcode != pool.barcode) return view
        this.nowMs = nowMs
        pool.acceptBarcodeText(text, nowMs)
        rankNow(nowMs, immediate = true)
        return view
    }

    /**
     * The hero was ticked (the caller already flipped `done` and passed the updated items): the
     * ranked order stays, the chips go dark and the hero waits for the next signal. That is the
     * "one tick ends the scan pass" rule, not an auto-commit.
     */
    fun commit(
        items: List<FlatItem>,
        vectors: Map<String, DoubleArray>?,
        nowMs: Long = this.nowMs,
    ): ScanView {
        this.nowMs = nowMs
        flat = items
        rankItems = items.toRankItems(vectors)
        armed = false
        committedBarcode = pool.barcode
        liveness.clear()
        rankNow(nowMs, immediate = true)
        return view
    }

    /** Camera closed: unranked flatten order (RANK.md §8), queries and state forgotten. */
    fun stop(): ScanView {
        pool.clear()
        queryCache.clear()
        liveness.clear()
        imageQuery = null
        armed = false
        lastResult = ticker.scanStopped(rankItems)
        view = render(lastResult!!, nowMs)
        return view
    }

    // ---------------------------------------------------------------- ranking

    private fun rankNow(nowMs: Long, immediate: Boolean) {
        pool.expire(nowMs)
        val textQueries = pool.textQueries().mapNotNull { queryVector(it) }
        val imageQueries = imageQuery?.takeIf { pool.imageFresh(nowMs) }?.let { listOf(it) } ?: emptyList()
        // The pool is the source of truth: replacing both lists means an expired word/frame stops
        // counting immediately instead of lingering as a stale query (RANK.md §7 "latest wins").
        ticker.submit(text = textQueries, image = imageQueries)
        val result = if (immediate) {
            ticker.tickNow(rankItems, nowMs, pool.barcodeText)
        } else {
            ticker.tick(rankItems, nowMs, pool.barcodeText)
        }
        if (result != null) lastResult = result
        view = lastResult?.let { render(it, nowMs) } ?: view.copy(chips = chips(nowMs))
    }

    /** Text → 256-d query vector, cached per session; null when the embedder cannot serve it. */
    private fun queryVector(text: String): DoubleArray? {
        queryCache.get(text)?.let { return it }
        val vec = embedder.text(text) ?: return null
        if (vec.size != dims || vec.any { !it.isFinite() }) return null
        queryCache.put(text, vec)
        return vec
    }

    /**
     * The sensor-orientation decision (card B5, mandatory): rotate the sideways JPEG upright **before**
     * embedding. A frame that cannot be rotated is not embedded at all — a sideways image query is
     * worse than none (it scores against the wrong geometry), and the OCR/barcode sources keep working.
     */
    private fun embedImage(signal: ScanSignal) {
        val jpeg = signal.jpeg ?: return
        val degrees = SensorRotation.uprightRotation(signal.rotationDegrees)
        val upright = if (degrees == 0) jpeg else rotator.rotateClockwise(jpeg, degrees) ?: return
        val vec = embedder.image(upright) ?: return
        if (vec.size != dims || vec.any { !it.isFinite() }) return
        imageQuery = vec
    }

    // ---------------------------------------------------------------- rendering

    private fun chips(nowMs: Long): ScanChips = ScanChips(
        barcode = liveness.lit(ScanKind.BARCODE, nowMs),
        text = liveness.lit(ScanKind.TEXT, nowMs),
        image = liveness.lit(ScanKind.IMAGE, nowMs),
    )

    private fun render(result: RankResult, nowMs: Long): ScanView {
        val chips = chips(nowMs)
        val barcode = pool.barcode
        val barcodeText = pool.barcodeText
        val error = embedder.error
        val base = ScanView(
            status = ScanStatus.NO_SIGNAL,
            chips = chips,
            barcode = barcode,
            barcodeText = barcodeText,
            ranked = result.ranked,
            error = error,
        )
        if (flat.isEmpty()) {
            return base.copy(
                status = ScanStatus.LIST_EMPTY,
                message = "This list has nothing left to buy.",
            )
        }
        if (rankItems.isEmpty() || rankItems.all { it.vec == null }) {
            // RANK.md §8 "some item vectors missing": the ranker keeps its previous output, which is
            // the flatten order on the first pass. Say why instead of pretending to rank.
            return base.copy(
                status = ScanStatus.NO_VECTORS,
                rows = flat.map { scanRow(it, null) },
                message = error ?: "Item embeddings are not ready — the list stays in its original order.",
            )
        }
        if (!result.ranked) {
            return base.copy(
                status = ScanStatus.NO_SIGNAL,
                rows = flat.map { scanRow(it, null) },
                message = "Point the camera at a product; the list re-sorts as it recognises it.",
            )
        }

        val itemById = flat.associateBy { it.id }
        val entryById = result.entries.associateBy { it.id }
        val heroId = result.topId?.takeIf { armed }
        val heroItem = heroId?.let { itemById[it] }
        val hero = if (heroId != null && heroItem != null) {
            ScanHero(
                id = heroItem.id,
                name = heroItem.name,
                detail = scanDetail(heroItem),
                score = entryById[heroId]?.smoothed ?: 0.0,
            )
        } else {
            null
        }

        val rows = ArrayList<ScanRow>(result.entries.size)
        val done = ArrayList<ScanRow>()
        for (entry in result.entries) {
            if (entry.id == hero?.id) continue
            val item = itemById[entry.id] ?: continue
            val row = scanRow(item, entry.smoothed)
            if (item.done) done += row else rows += row
        }

        val status = when {
            hero != null -> ScanStatus.HERO
            !armed -> ScanStatus.TICKED
            else -> ScanStatus.NO_HERO
        }
        val message = when (status) {
            ScanStatus.HERO -> null
            ScanStatus.TICKED -> "Ticked. Point at the next product."
            else -> noHeroMessage(barcodeText)
        }
        return base.copy(status = status, hero = hero, rows = rows, done = done, message = message)
    }

    /** Honest copy for "ranked, but nothing whose evidence clears the bar" (never a fake highlight). */
    private fun noHeroMessage(barcodeText: String?): String = if (barcodeText != null) {
        "Barcode “$barcodeText” — no confident match yet. Hold steadier, or tick an item below."
    } else {
        "Nothing confident yet — get closer to the product, or scan its barcode."
    }
}
