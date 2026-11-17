package dev.hajnina.scanlist.kotlin.rank

import java.text.Normalizer
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

// Kotlin port of `shared/spec/RANK.md` (normative v1 + card S10's highlight amendment): cosine
// scoring, max fusion, barcode boost, EMA smoothing, q6 rounding, the per-source highlight gates,
// output order and the §8 degraded states.
// The reference implementation is `shared/ref/scanlist_ref.py` (card S2) — this file mirrors its
// `rank()` / `q6()` / `decide_top()` / `unranked()` one for one, with the same float64 arithmetic.
//
// Card S10 separates `topId` (the HIGHLIGHT, nullable) from the ranking: [decideTop] runs hysteresis
// (§6.1), the per-source evidence gate (§6.2) and the image accept-list guard (§6.3), in that order,
// while `entries` always stays the full ranked order. Ranking order, scores and EMA state are
// unaffected. Full Unicode case folding for the barcode `norm()` lives in [fullCasefold] (CaseFold.kt).
//
// No Android, no model, no I/O: the whole file is pure Kotlin so the JVM golden test can replay
// `shared/fixtures/golden.json` without a device (card B3 Done-when).

/** RANK.md §2: active Matryoshka dims (first 256 components of the native 768). */
const val RANK_DIMS_ACTIVE: Int = 256

/** RANK.md §4: EMA weight (v1 default, uncalibrated — card X1 revises). */
const val RANK_EMA_ALPHA: Double = 0.5

/** RANK.md §6.1: the top switches only when a challenger is ahead by **strictly more** than this. */
const val RANK_HYSTERESIS: Double = 0.02

/** RANK.md §6.2: text-driven hero needs `q6(top1 − top2) >= MARGIN_TEXT` (inclusive). */
const val RANK_MARGIN_TEXT: Double = 0.05

/** RANK.md §6.2: text-driven hero needs `q6(hero) >= NO_MATCH_TEXT` (inclusive). */
const val RANK_NO_MATCH_TEXT: Double = 0.79

/** RANK.md §6.2: image-driven hero needs `q6(top1 − top2) >= MARGIN_IMAGE` (inclusive). */
const val RANK_MARGIN_IMAGE: Double = 0.005

/** RANK.md §6.2: image-driven hero needs `q6(hero) >= NO_MATCH_IMAGE` (inclusive). */
const val RANK_NO_MATCH_IMAGE: Double = 0.68

/** RANK.md §7: at most one evaluation per 400 ms (v1 default, uncalibrated — card X1 revises). */
const val RANK_MIN_INTERVAL_MS: Long = 400L

/** RANK.md §3: barcode name/alias exact-match boost, applied to `raw` before the EMA. */
const val RANK_BARCODE_BOOST: Double = 0.15

/** RANK.md §2.2: at most 16 text query vectors per tick (extra OCR lines dropped in order). */
const val RANK_MAX_TEXT_QUERIES: Int = 16

/**
 * RANK.md §5 `q6`: round-half-away-from-zero at 6 decimals, with `q6(-0.0) == 0.0`.
 *
 * Non-finite input is not a score (a NaN/Inf query vector must never leak into one, §8); it degrades
 * to `0.0` exactly like the Python reference. Everything that is stored or compared goes through this
 * function, which is what makes the golden comparisons exact.
 */
fun q6(value: Double): Double {
    if (!value.isFinite()) return 0.0
    if (value == 0.0) return 0.0
    val magnitude = floor(abs(value) * 1_000_000.0 + 0.5) / 1_000_000.0
    val rounded = Math.copySign(magnitude, value)
    return if (rounded == 0.0) 0.0 else rounded
}

/**
 * Dot product == cosine for two already normalised vectors (RANK.md §2), accumulated in float64 in
 * ascending index order (§5 recommends it; q6 makes the result insensitive to sub-1e-6 dot-order
 * noise, so this is deliberately a plain sequential sum rather than a compensated one).
 */
fun dot(a: DoubleArray, b: DoubleArray): Double {
    require(a.size == b.size) { "dot: ${a.size} dims vs ${b.size} dims" }
    var sum = 0.0
    for (i in a.indices) sum += a[i] * b[i]
    return sum
}

/**
 * RANK.md §2: keep the first [dims] components, widen to float64 (the model's float32 values widen
 * exactly) and L2-normalise; a vector whose norm is below `1e-12` becomes all zeros (cosine `0.0`
 * with everything, never NaN). Truncation happens **before** normalisation.
 */
fun truncateAndNormalize(vec: DoubleArray, dims: Int = RANK_DIMS_ACTIVE): DoubleArray {
    require(dims > 0) { "dims must be positive, was $dims" }
    require(vec.size >= dims) { "vector has ${vec.size} dims, need at least $dims" }
    val truncated = vec.copyOf(dims)
    var sum = 0.0
    for (v in truncated) {
        require(v.isFinite()) { "vector contains NaN/Inf" }
        sum += v * v
    }
    val norm = kotlin.math.sqrt(sum)
    if (norm < 1e-12) return DoubleArray(dims)
    return DoubleArray(dims) { truncated[it] / norm }
}

/**
 * RANK.md §3.1 `norm(s)`: NFC, **full Unicode case folding**, trim, every run of Unicode whitespace
 * collapsed to one space.
 *
 * The fold is [fullCasefold] (CaseFold.kt), not `lowercase(Locale.ROOT)`: Kotlin has no
 * `str.casefold()`, and simple lowercasing leaves `ß`, `ﬁ`, `ς` and Cherokee wrong. Only barcode
 * matching uses this; the ranking contract is unaffected.
 */
fun normBarcodeText(text: String): String {
    val folded = fullCasefold(Normalizer.normalize(text, Normalizer.Form.NFC))
    val out = StringBuilder(folded.length)
    var pendingSpace = false
    for (ch in folded) {
        if (isUnicodeWhitespace(ch)) {
            pendingSpace = out.isNotEmpty()
        } else {
            if (pendingSpace) out.append(' ')
            pendingSpace = false
            out.append(ch)
        }
    }
    return out.toString()
}

/** Python's `str.isspace()` set is `Character.isWhitespace` plus the Zs/Zl/Zp separators (NBSP…). */
private fun isUnicodeWhitespace(ch: Char): Boolean =
    ch.isWhitespace() || Character.isSpaceChar(ch)

/** RANK.md §3.1: exact (normalised) match against the item name or one of its aliases. */
fun barcodeMatches(name: String, aliases: List<String>, barcodeName: String?): Boolean {
    if (barcodeName.isNullOrEmpty()) return false
    val target = normBarcodeText(barcodeName)
    if (target.isEmpty()) return false
    if (normBarcodeText(name) == target) return true
    return aliases.any { normBarcodeText(it) == target }
}

/**
 * One flattened item plus its optional item vector (RANK.md §1). `vec` is the 256-d, already
 * truncated + L2-normalised vector, or `null` while the item is still embedding.
 *
 * The input `items` order is flatten order (FLATTEN.md §2); [order] is the stored flatten index and
 * is the §5 tie-breaker. Vectors live on this input copy only — flatten output never carries one.
 */
data class RankItem(
    val id: String,
    val name: String,
    val aliases: List<String> = emptyList(),
    val done: Boolean = false,
    val order: Int = 0,
    val vec: DoubleArray? = null,
)

/** The query vectors of one tick (RANK.md §1): text already prefixed + embedded, image unprefixed. */
data class RankQueries(
    val text: List<DoubleArray> = emptyList(),
    val image: List<DoubleArray> = emptyList(),
)

/** The caller-persisted part of a tick (RANK.md §1/§4). Only unchecked items appear in [smoothed]. */
data class RankState(
    val smoothed: Map<String, Double> = emptyMap(),
    val topId: String? = null,
) {
    companion object {
        val EMPTY = RankState()
    }
}

/** One output row (RANK.md §1). Checked items carry `raw = smoothed = null`; nobody scores them. */
data class RankEntry(
    val id: String,
    val raw: Double?,
    val smoothed: Double?,
    val done: Boolean,
)

/** The `rank()` result (RANK.md §1): highlight id, ordered entries and the state to persist. */
data class RankResult(
    val ranked: Boolean,
    val topId: String?,
    val entries: List<RankEntry>,
    val state: RankState,
) {
    /** First [n] non-done entries — `expectedTop3` in golden.json is exactly this. */
    fun topEntries(n: Int = 3): List<RankEntry> = entries.filter { !it.done }.take(n)

    internal fun withState(newState: RankState): RankResult = copy(state = newState)
}

/**
 * One evaluation tick (RANK.md §9). Pure: no I/O, no model, no clock — everything the caller owns
 * (`prev`, the cached [previous] output) is a parameter.
 *
 * @param items flatten order, each with its vector or `null` while still embedding.
 * @param queries text (prefixed) and image (unprefixed) query vectors; empty both == no signal.
 * @param prev the state returned by the previous tick.
 * @param barcodeName Open Food Facts product name (already `trim`med upstream), or `null`.
 * @param previous the previous tick's whole output; §8 "some item vectors still missing" returns it
 *   unchanged (with `prev`'s state). On the very first tick this is `null` → flatten order.
 * @param dims 256 in production, 4 in RANK.md §10's toy example (and the worked-example test).
 */
fun rank(
    items: List<RankItem>,
    queries: RankQueries? = null,
    prev: RankState? = null,
    barcodeName: String? = null,
    previous: RankResult? = null,
    dims: Int = RANK_DIMS_ACTIVE,
): RankResult {
    val prevSmoothed = prev?.smoothed.orEmpty()
    val prevTopId = prev?.topId
    val (textQueries, imageQueries) = cleanQueries(queries, dims)

    // §8 row 1: no text and no image query — unranked, state cleared, flatten order.
    if (textQueries.isEmpty() && imageQueries.isEmpty()) return unranked(items)

    val evaluated = ArrayList<RankItem>(items.size)
    var missing = false
    for (item in items) {
        if (item.done) continue
        if (usableVector(item.vec, dims) == null) {
            missing = true
            continue
        }
        evaluated += item
    }

    // §8 "some item vectors missing": do not evaluate, keep the previous output/state.
    if (missing) {
        val keptState = RankState(prevSmoothed, prevTopId)
        return previous?.withState(keptState) ?: unranked(items).withState(keptState)
    }

    // §8 "all items checked" (and the zero-items list): ranked, nothing highlighted, done group only.
    val doneEntries = items.filter { it.done }
        .sortedBy { it.order }
        .map { RankEntry(it.id, raw = null, smoothed = null, done = true) }
    if (evaluated.isEmpty()) {
        return RankResult(ranked = true, topId = null, entries = doneEntries, state = RankState.EMPTY)
    }

    val barcodeTarget = if (barcodeName == null) "" else normBarcodeText(barcodeName)
    val scored = ArrayList<RankCandidate>(evaluated.size)
    val smoothedById = LinkedHashMap<String, Double>(evaluated.size)
    val confirmedIds = HashSet<String>()
    for (item in evaluated) {
        val vec = item.vec!!
        // §3: per source the MAX over its queries (never a mean), then the max across the sources
        // present. Each cosine is q6-rounded after clamping to [-1, 1]. The per-source maxima are
        // kept too: §6.2 needs to know which source drove the winner (the text gate is stricter).
        var textMax = Double.NEGATIVE_INFINITY
        if (textQueries.isNotEmpty()) {
            var best = -1.0
            for (q in textQueries) {
                val cosine = q6(dot(vec, q).coerceIn(-1.0, 1.0))
                if (cosine > best) best = cosine
            }
            textMax = best
        }
        var imageMax = Double.NEGATIVE_INFINITY
        if (imageQueries.isNotEmpty()) {
            var best = -1.0
            for (q in imageQueries) {
                val cosine = q6(dot(vec, q).coerceIn(-1.0, 1.0))
                if (cosine > best) best = cosine
            }
            imageMax = best
        }
        val base = max(textMax, imageMax)
        // §3.1: the boost is part of `raw` (so it smooths) and is never clipped afterwards. A
        // confirmed item also joins the accept-list that §6.3 requires for an image-driven hero.
        val confirmed = barcodeTarget.isNotEmpty() && barcodeMatches(item.name, item.aliases, barcodeTarget)
        if (confirmed) confirmedIds += item.id
        val boost = if (confirmed) RANK_BARCODE_BOOST else 0.0
        val raw = q6(base + boost)
        val prevScore = prevSmoothed[item.id]
        // §4: alpha = 0.5, once per tick; the first observation equals `raw`. No time decay.
        val smoothed = if (prevScore == null) {
            raw
        } else {
            q6(RANK_EMA_ALPHA * raw + (1.0 - RANK_EMA_ALPHA) * prevScore)
        }
        smoothedById[item.id] = smoothed
        // §6.2: a tie between the sources counts as text, i.e. the stricter gate (fail-safe).
        val source = if (imageMax > textMax) RankSource.IMAGE else RankSource.TEXT
        scored += RankCandidate(item.id, item.order, raw, smoothed, source)
    }

    // §6: smoothed desc, then flatten order asc.
    scored.sortWith(compareByDescending<RankCandidate> { it.smoothed }.thenBy { it.order })
    val top = decideTop(scored, prevTopId, confirmedIds)

    val ordered = ArrayList<RankEntry>(scored.size)
    if (top != null) ordered += top.toEntry()
    for (entry in scored) if (top == null || entry.id != top.id) ordered += entry.toEntry()
    ordered += doneEntries

    val state = RankState(smoothedById, top?.id)
    return RankResult(ranked = true, topId = top?.id, entries = ordered, state = state)
}

/** `ranked = false`: flatten order, no scores, empty state (RANK.md §8 row 1 / §9 `unranked`). */
fun unranked(items: List<RankItem>): RankResult = RankResult(
    ranked = false,
    topId = null,
    entries = items.map { RankEntry(it.id, raw = null, smoothed = null, done = it.done) },
    state = RankState.EMPTY,
)

/**
 * RANK.md §6 / §9 `decide_top`: hysteresis (§6.1) → evidence gate (§6.2) → image guard (§6.3).
 *
 * `candidates` must already be sorted (`smoothed` desc, `order` asc). Hysteresis makes the previous
 * hero sticky inside the 0.02 band; a vanished/unticked hero hands over to `candidates[0]`. The gate
 * then asks whether the hero is *decisive* against the sorted runner-up (margin M on the top pair,
 * inclusive; vacuous with fewer than two candidates) and *plausible* on its own (floor T on the hero,
 * inclusive). `(M, T)` come from the hero's driving source; a tie counts as text (stricter). Finally
 * an image-driven hero must be confirmed by an exact barcode/OFF-name match; an unconfirmed image
 * winner is rendered in ranked order with no hero.
 *
 * @return the highlighted candidate, or `null` for "no highlight" (a normal state — `entries` stays
 *   the full ranked order and `state.topId` is `null`).
 */
fun decideTop(
    candidates: List<RankCandidate>,
    currentTopId: String?,
    barcodeConfirmedIds: Set<String> = emptySet(),
): RankCandidate? {
    if (candidates.isEmpty()) return null
    val best = candidates[0]
    val runnerUp = candidates.getOrNull(1)

    // 1. §6.1 hysteresis: the previous hero stays while it is inside the dead band.
    val current = if (currentTopId == null) null else candidates.firstOrNull { it.id == currentTopId }
    val hero = if (current != null && !(best.id != current.id && q6(best.smoothed - current.smoothed) > RANK_HYSTERESIS)) {
        current
    } else {
        best
    }

    // 2. §6.2 evidence gate: decisive against the runner-up and plausible on its own.
    val imageDriven = hero.source == RankSource.IMAGE
    val marginRequired = if (imageDriven) RANK_MARGIN_IMAGE else RANK_MARGIN_TEXT
    val floorRequired = if (imageDriven) RANK_NO_MATCH_IMAGE else RANK_NO_MATCH_TEXT
    if (runnerUp != null && q6(best.smoothed - runnerUp.smoothed) < marginRequired) return null
    if (q6(hero.smoothed) < floorRequired) return null

    // 3. §6.3 image guard: an image-driven hero needs accept-list confirmation.
    if (imageDriven && hero.id !in barcodeConfirmedIds) return null
    return hero
}

/** Which source produced a candidate's `base` score (RANK.md §3/§6.2); a tie is [TEXT]. */
enum class RankSource { TEXT, IMAGE }

/** One scored candidate as seen by [decideTop] — the stored (q6) values plus the flatten order tie-break. */
data class RankCandidate(
    val id: String,
    val order: Int,
    val raw: Double,
    val smoothed: Double,
    val source: RankSource = RankSource.TEXT,
) {
    fun toEntry(): RankEntry = RankEntry(id, raw, smoothed, done = false)
}

/**
 * §2.2/§8 query hygiene: wrong-dim and NaN/Inf query vectors are dropped (they may never propagate
 * into a score); an all-zero query is kept (cosine `0.0` with everything). Text is capped at 16.
 */
private fun cleanQueries(
    queries: RankQueries?,
    dims: Int,
): Pair<List<DoubleArray>, List<DoubleArray>> {
    if (queries == null) return emptyList<DoubleArray>() to emptyList()
    fun clean(raw: List<DoubleArray>): List<DoubleArray> = raw.filter { vec ->
        vec.size == dims && vec.all { it.isFinite() }
    }
    val text = clean(queries.text).take(RANK_MAX_TEXT_QUERIES)
    val image = clean(queries.image)
    return text to image
}

/** §8: an item vector is usable only when it has exactly [dims] finite components. */
private fun usableVector(vec: DoubleArray?, dims: Int): DoubleArray? {
    if (vec == null || vec.size != dims) return null
    for (v in vec) if (!v.isFinite()) return null
    return vec
}
