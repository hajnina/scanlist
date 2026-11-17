package dev.hajnina.scanlist.kotlin.scan.ui

import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.hajnina.scanlist.embed.EmbedderConfig
import dev.hajnina.scanlist.embed.Embedders
import dev.hajnina.scanlist.embed.Prompts
import dev.hajnina.scanlist.kotlin.list.FlatItem
import dev.hajnina.scanlist.kotlin.rank.AppEmbedding
import dev.hajnina.scanlist.kotlin.rank.EmbedderVectorSource
import dev.hajnina.scanlist.kotlin.rank.VectorSource
import dev.hajnina.scanlist.kotlin.rank.defaultModelFile
import dev.hajnina.scanlist.kotlin.scan.sources.Clock
import dev.hajnina.scanlist.kotlin.scan.sources.ScanKind
import dev.hajnina.scanlist.kotlin.scan.sources.ScanSignal
import dev.hajnina.scanlist.kotlin.settings.BackendChoice
import dev.hajnina.scanlist.kotlin.settings.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "ScanListScan"

/**
 * Where the barcode chip stands: OFF.md §4/§5 "failure is normal", so this is display state, never
 * an error that blocks the camera.
 */
enum class OffUiState { IDLE, LOOKING_UP, FOUND, NO_TEXT, MISS, OFFLINE, INVALID }

/** The barcode strip's story for the current pass. */
data class BarcodeUi(
    val barcode: String? = null,
    val state: OffUiState = OffUiState.IDLE,
    val text: String? = null,
    val note: String? = null,
)

/**
 * The Android/Compose edge of the magic scan (card B5): serialises every piece of work onto one
 * background lane so the 2.5 fps camera can never block the main thread on a native embed, and turns
 * [ScanSession]'s view into Compose state.
 *
 * Rules kept deliberately thin here (the decisions are in the tested classes):
 *  - signals are queued and drained by one worker (`pump`); a newer frame replaces a queued one, so a
 *    slow embed can never build a backlog of stale frames,
 *  - the barcode lookup runs on its own coroutine ([Dispatchers.IO]) with OFF's single-flight journal,
 *    and its answer is only applied to the barcode it was asked for,
 *  - a tick calls the caller's `onTick` (B2's list repository) and re-ranks with the updated list.
 */
class ScanController(
    private val scope: CoroutineScope,
    private val session: ScanSession,
    private val resolver: OffResolver?,
    private val clock: Clock,
    private val items: () -> List<FlatItem>,
    private val vectors: () -> Map<String, DoubleArray>?,
    private val onTick: (String) -> Unit,
    private val wallClockMs: () -> Long = { System.currentTimeMillis() },
) {
    /** The screen's whole ranked state. Writes happen on the worker; Compose reads snapshots. */
    var view by mutableStateOf(ScanView.INITIAL)
        private set

    var barcodeUi by mutableStateOf(BarcodeUi())
        private set

    private val lock = Any()
    private val tasks = ArrayDeque<() -> Unit>()
    private var pumping = false
    /** Newest frame waiting for the embed lane; older ones are overwritten (RANK.md §7 latest wins). */
    private var pendingImage: ScanSignal? = null
    private var imageDraining = false
    private val journal = OffJournal()

    /** Compose entered the Scan tab: frame an empty scan session (immediate first ranking). */
    fun start() = enqueue {
        publish(session.start(items(), vectors(), clock.nowMs()))
        barcodeUi = BarcodeUi()
    }

    /** The list or its item vectors changed (open, import, tick elsewhere). */
    fun refresh() = enqueue { publish(session.items(items(), vectors(), clock.nowMs())) }

    /** One live signal from the camera (any thread). */
    fun onSignal(signal: ScanSignal) {
        if (signal.kind == ScanKind.IMAGE) {
            // Newest-frame-wins coalescing: a frame that arrives while an embed is in flight (or
            // still queued) replaces the older pending frame, so the next embed is the freshest
            // picture, never the stale one the camera moved past.
            val startDrain = synchronized(lock) {
                pendingImage = signal
                if (imageDraining) false else {
                    imageDraining = true
                    true
                }
            }
            if (startDrain) enqueue { drainImages() }
            return
        }
        enqueue {
            publish(session.signal(signal))
            if (signal.kind == ScanKind.BARCODE) lookupBarcode(session.barcode)
        }
    }

    /**
     * Embeds **one** pending frame, then yields the lane: if another frame arrived meanwhile it is
     * re-enqueued at the back of the queue, so an OCR/TICK/OFF task that was already waiting runs
     * between frames instead of starving behind a camera that never pauses (a CPU embed can easily
     * outlast the ~400 ms frame cadence). The frame choice is still newest-wins, because coalescing
     * happens in [onSignal] while the previous frame is embedding.
     */
    private fun drainImages() {
        val next = synchronized(lock) {
            val queued = pendingImage
            if (queued == null) {
                imageDraining = false
                null
            } else {
                pendingImage = null
                queued
            }
        }
        if (next == null) return
        publish(session.signal(next))

        val again = synchronized(lock) {
            if (pendingImage == null) {
                imageDraining = false
                false
            } else {
                true
            }
        }
        if (again) enqueue { drainImages() }
    }

    /** The big tick: commit to the list (never automatic) and re-rank with the updated `done` flags. */
    fun tickHero() {
        val heroId = view.hero?.id ?: return
        enqueue {
            onTick(heroId)
            publish(session.commit(items(), vectors(), clock.nowMs()))
        }
    }

    /** Leaving the tab: unranked flatten order, camera resources are the preview's business. */
    fun stop() = enqueue { publish(session.stop()) }

    // ---------------------------------------------------------------- worker

    private fun enqueue(task: () -> Unit) {
        synchronized(lock) {
            tasks.addLast(task)
            if (pumping) return
            pumping = true
        }
        scope.launch { pump() }
    }

    private suspend fun pump() {
        while (true) {
            val task = synchronized(lock) {
                tasks.removeFirstOrNull() ?: run {
                    pumping = false
                    return
                }
            }
            withContext(Dispatchers.Default) {
                runCatching { task() }.onFailure { Log.w(TAG, "scan task failed", it) }
            }
        }
    }

    private fun publish(next: ScanView) {
        view = next
    }

    // ---------------------------------------------------------------- OFF (barcode → text)

    private fun lookupBarcode(barcode: String?) {
        val digits = barcode ?: return
        val resolver = resolver ?: return
        if (!OffRequest.isValidBarcode(digits)) {
            barcodeUi = BarcodeUi(digits, OffUiState.INVALID, note = "not an EAN/UPC barcode")
            return
        }
        if (!journal.begin(digits)) return // single-flight: one request per barcode
        barcodeUi = BarcodeUi(digits, OffUiState.LOOKING_UP)

        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { resolver.lookup(digits, wallClockMs()) }.getOrNull()
            }
            journal.end(digits)
            enqueue {
                // A slow answer for barcode A must not repaint the strip after the user scanned B:
                // the strip describes the barcode in view, exactly like the ranking-side guard in
                // ScanSession.barcodeText(). A superseded answer still warms the OFF cache.
                if (session.barcode == digits) {
                    barcodeUi = BarcodeUi(
                        barcode = digits,
                        state = stateFor(result),
                        text = result?.text,
                        note = result?.note,
                    )
                }
                // Applies to the barcode it was asked for, even if the response came back late.
                publish(session.barcodeText(result?.text, forBarcode = digits, nowMs = clock.nowMs()))
            }
        }
    }

    private fun stateFor(result: OffLookupResult?): OffUiState = when {
        result == null -> OffUiState.OFFLINE
        result.text != null -> OffUiState.FOUND
        result.outcome == OffOutcome.TRANSIENT -> OffUiState.OFFLINE
        result.hit -> OffUiState.NO_TEXT
        else -> OffUiState.MISS
    }
}

/**
 * The scan screen's embedding stack, honouring the backend the user picked in Settings (card B6).
 *
 * `auto` (the shipped default) reuses card B3's process-wide embedder, so the whole app keeps **one**
 * resident model (RECIPE.md §7.4) — query vectors and item vectors then live in the same process and
 * the same 768-d space. A strict `gpu`/`cpu`/`npu` choice opens its own engine with exactly that
 * ladder (that is what the picker promises, card B6); it is kept for the process lifetime because
 * re-creating a 440 M-parameter model on every tab switch would cost seconds and ~0.5 GB.
 */
internal object SearchEmbedding {

    private class Holder(val choice: BackendChoice, val source: VectorSource)

    @Volatile
    private var holder: Holder? = null

    fun source(context: Context): VectorSource {
        val choice = SettingsStore.forFilesDir(context.filesDir).backend()
        holder?.takeIf { it.choice == choice }?.let { return it.source }
        synchronized(this) {
            holder?.takeIf { it.choice == choice }?.let { return it.source }
            val source = if (choice == BackendChoice.AUTO) {
                AppEmbedding.get(context).source
            } else {
                val modelId = runCatching { Prompts.load(context).model }
                    .getOrDefault(EmbedderConfig.DEFAULT_MODEL_ID)
                EmbedderVectorSource(
                    Embedders.create(context, choice.config(defaultModelFile(context), modelId)),
                )
            }
            holder = Holder(choice, source)
            return source
        }
    }
}

/**
 * Pulls the query embedder out of [SearchEmbedding] lazily, on the worker thread that first needs it:
 * opening the model is seconds of native work and must never run in composition.
 */
class LazyQueryEmbedder(
    private val provider: () -> QueryEmbedder,
    override val dims: Int,
) : QueryEmbedder {

    @Volatile
    override var error: String? = null
        private set

    private var delegate: QueryEmbedder? = null

    private fun embedder(): QueryEmbedder? {
        delegate?.let { return it }
        return runCatching { provider() }
            .onFailure { error = it.message ?: it.javaClass.simpleName }
            .getOrNull()
            ?.also { delegate = it; error = null }
    }

    override fun text(text: String): DoubleArray? {
        val target = embedder() ?: return null
        val vec = target.text(text)
        if (vec == null) error = target.error
        return vec
    }

    override fun image(jpeg: ByteArray): DoubleArray? {
        val target = embedder() ?: return null
        val vec = target.image(jpeg)
        if (vec == null) error = target.error
        return vec
    }
}
