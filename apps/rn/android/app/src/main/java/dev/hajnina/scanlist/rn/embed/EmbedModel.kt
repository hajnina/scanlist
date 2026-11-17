package dev.hajnina.scanlist.rn.embed

import android.content.Context
import java.io.File

/**
 * Where the EmbeddingGemma 2 bundle is expected on the device (card A3).
 *
 * The library never downloads it (`shared/android-embed/README.md`): `scripts/model.sh push <package>`
 * copies ONE `.litertlm` into the app's own files dir, under `models/`. That script uses
 * `<files>/models/embeddinggemma-2-740m.litertlm` (internal or external files dir, `--dest`), while
 * `LiteRtEmbedder.defaultModelFile()` points at `<external files>/models/<modelId>/<modelId>.litertlm`.
 * The mismatch is card S6's to settle; until then this module accepts both layouts, internal first.
 *
 * Nothing here downloads or creates the file: a missing model is reported to JS as
 * `E_MODEL_MISSING` with the exact push command, which is the expected state until card B0 provisions
 * a device.
 */
internal object EmbedModel {

    /** The file name pinned by `scripts/model.sh` (MODEL_NAME) and `EmbedderConfig.DEFAULT_MODEL_ID`. */
    const val FILE_NAME = "embeddinggemma-2-740m.litertlm"

    private const val MODEL_ID = "embeddinggemma-2-740m"

    private const val SUBDIR = "models"

    /** First existing candidate, or null. Never creates anything. */
    fun find(context: Context): File? = candidates(context).firstOrNull { it.isFile }

    /** Every layout the app reads, in priority order (internal files dir first: `--dest internal`). */
    fun candidates(context: Context): List<File> {
        val dirs = buildList {
            add(context.filesDir)
            context.getExternalFilesDir(null)?.let { add(it) }
        }
        return dirs.flatMap { dir ->
            listOf(
                File(File(dir, SUBDIR), FILE_NAME),
                File(File(File(dir, SUBDIR), MODEL_ID), FILE_NAME),
            )
        }
    }

    /** The one command that fixes [E_MODEL_MISSING] — shown on the dev screen as-is. */
    fun pushHint(context: Context): String = "scripts/model.sh push ${context.packageName}"
}
