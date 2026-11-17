package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.list.FlatItem
import dev.hajnina.scanlist.kotlin.list.text
import dev.hajnina.scanlist.kotlin.rank.VectorSource

// The scan screen's own vocabulary (card B5). Everything here is Android-free except the two
// interfaces (embedding + JPEG rotation), which the Compose layer fills in with shared/android-embed
// and android.graphics; the pure classes next to this file (SignalPool, ScanSession, Off*) are what
// the JVM tests drive with synthetic signals.

/**
 * Exactly what the scan screen needs from the embedding stack, in **float64** (RANK.md §2), blocking,
 * null on failure so a dead embedder degrades to "no signal" instead of crashing the camera.
 *
 * Text is a *raw* query (barcode name / OCR line): the implementation adds `prompts.json`'s query
 * prefix (card B3's [VectorSource] does). Images take no prefix — and the bytes handed here are
 * already upright (see [SensorRotation]), never sensor-sideways.
 */
interface QueryEmbedder {
    /** Matryoshka dims (256); query vectors of another size are dropped by the ranker anyway. */
    val dims: Int

    /** Human-readable reason the embedder last failed, for the screen's honest "ranking is off" line. */
    val error: String? get() = null

    fun text(text: String): DoubleArray?

    fun image(jpeg: ByteArray): DoubleArray?
}

/**
 * [QueryEmbedder] over card B3's [VectorSource] (the shared `shared/android-embed` embedder). The only
 * place the scan screen touches the embed library; failures are caught here and surfaced in [error]
 * because one bad frame must never take down the scan loop (OFF.md §5 "failure is normal").
 */
class VectorSourceQueryEmbedder(private val source: VectorSource) : QueryEmbedder {

    override val dims: Int get() = source.dims

    @Volatile
    override var error: String? = null
        private set

    override fun text(text: String): DoubleArray? = runCatching { source.embedQuery(text) }
        .onFailure { error = it.message ?: it.javaClass.simpleName }
        .getOrNull()

    override fun image(jpeg: ByteArray): DoubleArray? = runCatching { source.embedImage(jpeg) }
        .onFailure { error = it.message ?: it.javaClass.simpleName }
        .getOrNull()
}

/**
 * Clockwise JPEG rotation seam (card B5's sensor-orientation decision).
 *
 * Card B4 established that the IMAGE signal's bytes are **sensor-oriented**: `rotationDegrees` went
 * to ML Kit only, so the JPEG is usually 90° sideways relative to what the user sees. The scan screen
 * rotates it before embedding; the decision (how many degrees, and whether to rotate at all) lives in
 * [SensorRotation] + [ScanSession] and is JVM-tested, while the pixels are an Android Bitmap job
 * ([JpegRotation]).
 */
fun interface ImageRotator {
    /** Rotated JPEG bytes, or null when the input could not be decoded. */
    fun rotateClockwise(jpeg: ByteArray, degrees: Int): ByteArray?

    companion object {
        /** No rotation (JVM tests, or a session that has no bitmap capability). */
        val NONE: ImageRotator = ImageRotator { jpeg, _ -> jpeg }
    }
}

/** Why the ranked list looks the way it does; the UI never re-decides, it only explains. */
enum class ScanStatus {
    /** No list selected / no list imported yet. */
    NO_LIST,

    /** The selected list has nothing left to buy. */
    LIST_EMPTY,

    /** Item vectors are missing (model not pushed / embedding still running): flatten order is shown. */
    NO_VECTORS,

    /** Nothing to rank by (no live barcode text, OCR line or frame): flatten order is shown. */
    NO_SIGNAL,

    /** Ranked, but `decideTop` returned no highlight: "nothing confident yet", honestly. */
    NO_HERO,

    /** `decideTop`'s highlight, rendered as the hero card. */
    HERO,

    /** One tick just happened: the ranked list stays, the hero waits for the next signal (one-per-pass). */
    TICKED,
}

/** The hero card: exactly [dev.hajnina.scanlist.kotlin.rank.RankResult.topId], plus display fields. */
data class ScanHero(
    val id: String,
    val name: String,
    val detail: String,
    val score: Double,
)

/** One ranked row (the hero is rendered separately and never duplicated here). */
data class ScanRow(
    val id: String,
    val name: String,
    val detail: String,
    val score: Double?,
    val done: Boolean,
)

/** Which scan sources are lit right now (BARCODE / TEXT / IMAGE chips). */
data class ScanChips(
    val barcode: Boolean = false,
    val text: Boolean = false,
    val image: Boolean = false,
) {
    val any: Boolean get() = barcode || text || image
}

/** Everything the scan screen renders for one tick. Immutable; produced by [ScanSession]. */
data class ScanView(
    val status: ScanStatus,
    val hero: ScanHero? = null,
    val rows: List<ScanRow> = emptyList(),
    val done: List<ScanRow> = emptyList(),
    val chips: ScanChips = ScanChips(),
    /** The barcode digits the current pass is about (OFF.md §4 cache key), if any. */
    val barcode: String? = null,
    /** OFF.md §3 derived product text, or null while unknown / unresolvable. */
    val barcodeText: String? = null,
    /** One honest sentence for the state (null while a hero is showing). */
    val message: String? = null,
    val ranked: Boolean = false,
    /** Embedder failure text, when there is one (shown as a small monospace line). */
    val error: String? = null,
) {
    companion object {
        val INITIAL: ScanView = ScanView(status = ScanStatus.NO_LIST)
    }
}

/** `amount + " · " + section path` (empty when the item has neither) — the hero/row second line. */
internal fun scanDetail(item: FlatItem): String {
    val amount = item.amount?.text().orEmpty()
    val unit = item.unit.orEmpty()
    val quantity = if (amount.isNotEmpty() && unit.isNotEmpty()) "$amount $unit" else amount
    return listOf(quantity, item.pathText).filter { it.isNotEmpty() }.joinToString(" · ")
}

/** One flattened item as a row; [score] is the ranker's `smoothed` value (null when unranked). */
internal fun scanRow(item: FlatItem, score: Double?): ScanRow = ScanRow(
    id = item.id,
    name = item.name,
    detail = scanDetail(item),
    score = score,
    done = item.done,
)
