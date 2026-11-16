package dev.hajnina.scanlist.embed

import android.content.Context

/** Where the engine runs. [IN_PROCESS] is the default (card S5); [ISOLATED] survives a driver crash. */
enum class ProcessMode {
    IN_PROCESS,
    ISOLATED,
}

/**
 * The one place that builds an [Embedder] for a scanlist app (cards A3, B1, B3 consume this).
 *
 * ```kotlin
 * val embedder = Embedders.create(context, EmbedderConfig(modelFile = File(filesDir, "embeddinggemma-2-740m.litertlm")))
 * val items = embedder.embedDocs(listOf("milk", "bread"))
 * val frame = embedder.embedImage(jpeg)
 * ```
 */
object Embedders {

    /** In-process by default. [ISOLATED] uses the manifest-declared `:embed` service ([RemoteEmbedder]). */
    fun create(
        context: Context,
        config: EmbedderConfig,
        mode: ProcessMode = ProcessMode.IN_PROCESS,
    ): Embedder = when (mode) {
        ProcessMode.IN_PROCESS -> LiteRtEmbedder.create(context, config)
        ProcessMode.ISOLATED -> RemoteEmbedder(context, config)
    }
}
