package dev.hajnina.scanlist.kotlin.rank

import android.content.Context
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.hajnina.scanlist.embed.Embedder
import dev.hajnina.scanlist.embed.EmbedderConfig
import dev.hajnina.scanlist.embed.EmbedderException
import dev.hajnina.scanlist.embed.Embedders
import dev.hajnina.scanlist.embed.Prompts
import dev.hajnina.scanlist.kotlin.list.FlatItem
import dev.hajnina.scanlist.kotlin.list.docText
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Card B3's Android + Compose edge: "embed items via shared/android-embed on list open (background,
// progress), cache vectors on disk". Everything testable (keys, files, batching, ranking) is in
// Rank.kt / ItemVectorCache.kt / ItemVectorIndex.kt; this file adds only the process-wide embedder,
// the files dir and the Compose state the screen reads. The screen wiring is one call —
// `rememberListEmbedding(context, list.id, index.items)` — kept deliberately out of the UI.

private const val TAG = "ScanListRank"

/** Where `scripts/model.sh push` puts the bundle: `<files>/models/embeddinggemma-2-740m.litertlm`. */
val defaultModelFile: (Context) -> File = { context ->
    File(File(context.filesDir, "models"), "embeddinggemma-2-740m.litertlm")
}

/**
 * One process-wide embedding stack (RECIPE.md §7.4: one resident model). Created lazily on the
 * background thread that first embeds a list; `null` source means a text-only/absent bundle, which
 * surfaces as a clear [EmbeddingPhase.FAILED] instead of a crash on list open.
 */
internal class EmbeddingRuntime(private val appContext: Context) : AutoCloseable {

    private var embedder: Embedder? = null

    val prompts: Prompts by lazy { Prompts.load(appContext) }

    val cache: ItemVectorCache by lazy {
        val loaded = prompts
        ItemVectorCache(
            dir = ItemVectorCache.defaultDir(appContext.filesDir),
            modelId = loaded.model,
            dims = loaded.activeDims,
            docPrefix = loaded.docPrefix,
            prefixSet = loaded.active,
        )
    }

    val source: VectorSource by lazy {
        val modelFile = defaultModelFile(appContext)
        if (!modelFile.isFile) {
            throw EmbedderException(
                "EmbeddingGemma 2 bundle missing at ${modelFile.path}. " +
                    "Push it with `scripts/model.sh push <package>` (card S6); item vectors stay uncached " +
                    "until then — the list still opens and renders unranked.",
            )
        }
        val config = EmbedderConfig(modelFile = modelFile, modelId = prompts.model)
        val created = Embedders.create(appContext, config)
        embedder = created
        EmbedderVectorSource(created)
    }

    val index: ItemVectorIndex by lazy { ItemVectorIndex(cache, source) }

    override fun close() {
        embedder?.close()
        embedder = null
    }
}

/** The app-wide runtime; tests never touch this (they use their own [ItemVectorCache] + fake source). */
internal object AppEmbedding {
    @Volatile
    private var runtime: EmbeddingRuntime? = null

    fun get(context: Context): EmbeddingRuntime = runtime ?: synchronized(this) {
        runtime ?: EmbeddingRuntime(context.applicationContext).also { runtime = it }
    }
}

/** Lifecycle of the on-open embedding pass, as the list screen consumes it. */
enum class EmbeddingPhase { IDLE, RUNNING, READY, FAILED }

/** Observable state of one list's embedding pass (Compose state; safe to read in composition). */
class ListEmbeddingState internal constructor() {
    var phase by mutableStateOf(EmbeddingPhase.IDLE)
        internal set

    /** Items embedded / cached so far, for a progress line (never feeds the ranker). */
    var progress by mutableStateOf(EmbedProgress(0, 0, 0, 0, 0))
        internal set

    /** The vectors once [phase] is [EmbeddingPhase.READY] (partial after a failure). */
    var vectors by mutableStateOf<ItemVectors?>(null)
        internal set

    /** Human-readable reason for [EmbeddingPhase.FAILED]; the list stays usable unranked. */
    var error by mutableStateOf<String?>(null)
        internal set
}

/**
 * Embed [items] in the background on list open, reporting progress, and expose the result as Compose
 * state. Idempotent per list: the pass runs when the list (or its doc texts) changes, cache hits are
 * file reads, and leaving the screen tears down the state — the coroutine is cancelled between
 * batches, but a batch already handed to the embedder runs to completion (the disk cache keeps
 * whatever finished either way).
 *
 * This is the only function a screen needs; it never throws — a missing model or an embedder failure
 * lands in [ListEmbeddingState.error].
 */
@Composable
fun rememberListEmbedding(
    context: Context,
    listId: String,
    items: List<FlatItem>,
): ListEmbeddingState {
    val docs = remember(items) { items.map { ItemDoc(it.id, it.docText()) } }
    val state = remember(listId) { ListEmbeddingState() }
    LaunchedEffect(listId, docs) {
        state.phase = EmbeddingPhase.RUNNING
        state.error = null
        try {
            val vectors = withContext(Dispatchers.IO) {
                val index = AppEmbedding.get(context).index
                index.embed(docs, onProgress = { progress -> state.progress = progress })
            }
            state.vectors = vectors
            state.phase = EmbeddingPhase.READY
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (t: Throwable) {
            Log.w(TAG, "item embedding unavailable; the list stays unranked", t)
            state.error = t.message ?: t.javaClass.simpleName
            state.phase = EmbeddingPhase.FAILED
        }
    }
    return state
}

/**
 * Flattened items → ranker input (RANK.md §1: `vec` lives on the input copy, never on flatten
 * output). Items without a vector stay `null`, which RANK.md §8 treats as "not embedded yet".
 */
fun List<FlatItem>.toRankItems(vectors: Map<String, DoubleArray>?): List<RankItem> = map { item ->
    RankItem(
        id = item.id,
        name = item.name,
        aliases = item.aliases,
        done = item.done,
        order = item.order,
        vec = vectors?.get(item.id),
    )
}
