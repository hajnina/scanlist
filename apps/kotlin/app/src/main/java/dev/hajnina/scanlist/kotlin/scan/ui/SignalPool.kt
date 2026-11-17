package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.rank.RANK_MAX_TEXT_QUERIES

/**
 * The live text-query pool of one scan session (card B5's **pool-order** decision).
 *
 * RANK.md §2.2 allows at most 16 text query vectors per tick and the ranker keeps the **first 16 in
 * arrival order** (`Rank.cleanQueries` → `take(RANK_MAX_TEXT_QUERIES)`). A single OCR pass may emit
 * 16 lines, and if the barcode arrives after them the 17th candidate — the barcode's OFF product
 * name — would be the one dropped. The spec says the opposite: extra OCR **lines** are dropped, the
 * barcode stays.
 *
 * This pool therefore owns the ordering rule so the rank package does not have to:
 *  - the OFF-derived barcode text is always slot 1 when present,
 *  - OCR lines follow in arrival order, and only the first `16 − (barcode text ? 1 : 0)` survive,
 *  - a line identical to the barcode text is not embedded twice,
 *  - the OCR line that is just the barcode digits (ML Kit happily OCRs the number it decoded) is
 *    not embedded either — RANK.md §8 forbids embedding the raw barcode.
 *
 * A scan is a live thing, so entries expire: OCR words belong to the product in front of the camera
 * *now*, and a stale frame or a word read five seconds ago must stop driving the ranking. The barcode
 * is product identity and lasts longer.
 *
 * Pure Kotlin + an explicit timeline; unit-tested without Android.
 */
class SignalPool(
    private val maxTextQueries: Int = RANK_MAX_TEXT_QUERIES,
    private val ocrTtlMs: Long = DEFAULT_OCR_TTL_MS,
    private val imageTtlMs: Long = DEFAULT_IMAGE_TTL_MS,
    private val barcodeTtlMs: Long = DEFAULT_BARCODE_TTL_MS,
) {
    init {
        require(maxTextQueries >= 1) { "maxTextQueries must be >= 1" }
        require(ocrTtlMs > 0 && imageTtlMs > 0 && barcodeTtlMs > 0) { "TTLs must be positive" }
    }

    /** The barcode digits of the current pass (OFF.md §4 cache key), or null. */
    var barcode: String? = null
        private set

    /** OFF.md §3 derived text of [barcode] (what gets embedded and boosted), or null. */
    var barcodeText: String? = null
        private set

    private var barcodeAtMs: Long = 0L

    /** OCR line → the moment it was last seen (insertion order = arrival order). */
    private val ocr = LinkedHashMap<String, Long>()

    private var imageAtMs: Long? = null

    /**
     * A decoded barcode. Returns true when it is a **new** product: the previous OFF name is dropped,
     * because a name belongs to the barcode it was looked up for (OFF.md §2: the digit string is the
     * cache key, verbatim).
     */
    fun acceptBarcode(value: String, nowMs: Long): Boolean {
        val digits = value.trim()
        if (digits.isEmpty()) return false
        val changed = digits != barcode
        barcode = digits
        barcodeAtMs = nowMs
        if (changed) barcodeText = null
        return changed
    }

    /** The OFF lookup outcome for the current barcode (`null` = no usable name, a valid negative). */
    fun acceptBarcodeText(text: String?, nowMs: Long) {
        barcodeText = text?.trim()?.takeIf { it.isNotEmpty() }
    }

    /**
     * One OCR line. Returns true when the pool accepted it (non-blank and not the barcode digits).
     * Re-seeing a line refreshes its position and age, so a product held still stays ranked.
     */
    fun acceptOcr(line: String, nowMs: Long): Boolean {
        val text = line.trim()
        if (text.isEmpty()) return false
        // RANK.md §8: the raw barcode number is never a text query; OCR often reads it back to us.
        if (text == barcode) return false
        ocr.remove(text)
        ocr[text] = nowMs
        while (ocr.size > maxTextQueries) {
            val oldest = ocr.keys.iterator()
            oldest.next()
            oldest.remove()
        }
        return true
    }

    /** One frame arrived (the vector itself lives in [ScanSession]); refreshed every sampler tick. */
    fun noteImage(nowMs: Long) {
        imageAtMs = nowMs
    }

    /** Drop everything that is older than its source's TTL on the caller's timeline. */
    fun expire(nowMs: Long) {
        ocr.entries.removeAll { nowMs - it.value >= ocrTtlMs }
        imageAtMs = imageAtMs?.takeIf { nowMs - it < imageTtlMs }
        if (barcode != null && nowMs - barcodeAtMs >= barcodeTtlMs) {
            barcode = null
            barcodeText = null
        }
    }

    /**
     * The text strings to embed this tick, **barcode first**, at most [maxTextQueries].
     *
     * This is the ranking input (before the query prefix), not the display text: the caller embeds
     * each one and hands the vectors to `RankTicker.submit(text = …)`.
     */
    fun textQueries(nowMs: Long? = null): List<String> {
        if (nowMs != null) expire(nowMs)
        val out = ArrayList<String>(minOf(maxTextQueries, ocr.size + 1))
        val barcodeName = barcodeText
        if (barcodeName != null) out += barcodeName
        for (line in ocr.keys) {
            if (out.size >= maxTextQueries) break
            // Never embed the same product text twice, and never embed the raw digits (RANK.md §8).
            if (line == barcodeName || line == barcode) continue
            out += line
        }
        return out
    }

    /** True while the latest frame is fresh enough to rank with. */
    fun imageFresh(nowMs: Long): Boolean = imageAtMs?.let { nowMs - it < imageTtlMs } ?: false

    /** True while the barcode (and its OFF name) still belongs to the current pass. */
    fun barcodeFresh(nowMs: Long): Boolean = barcode != null && nowMs - barcodeAtMs < barcodeTtlMs

    /** Number of OCR lines currently pooled (diagnostics + tests). */
    val ocrSize: Int get() = ocr.size

    /** The pooled OCR lines, arrival order (the "has this product changed?" snapshot). */
    fun ocrLines(): Set<String> = ocr.keys.toSet()

    /** True when [line] is already pooled (so a commit can tell a re-read from a new product). */
    fun knowsOcr(line: String): Boolean = ocr.containsKey(line.trim())

    fun clear() {
        barcode = null
        barcodeText = null
        barcodeAtMs = 0L
        ocr.clear()
        imageAtMs = null
    }

    companion object {
        /** A word stays a query for 3 s after it was last read (ML Kit re-emits held text every 1.5 s). */
        const val DEFAULT_OCR_TTL_MS: Long = 3_000L

        /** The sampler emits at 2.5 fps; a frame older than 2.5 s is one the user has moved away from. */
        const val DEFAULT_IMAGE_TTL_MS: Long = 2_500L

        /** BarcodeDeduplicator re-emits every 3 s; keep the OFF name while the product stays in view. */
        const val DEFAULT_BARCODE_TTL_MS: Long = 30_000L
    }
}
