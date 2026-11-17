package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.EmbedderConfig
import java.io.File
import java.util.Locale

/**
 * What the app can say about the EmbeddingGemma 2 bundle without opening it (card B6: "model file
 * status + path").
 *
 * The settings screen probes **the file the embedding pipeline actually opens**
 * (`<filesDir>/models/embeddinggemma-2-740m.litertlm`, card B3's `rank.defaultModelFile`), so a
 * missing bundle is reported exactly where the pipeline would fail — not at some other documented
 * path. Only the file system is consulted: existence, readability, size. The sha256 is deliberately
 * NOT recomputed on every settings visit (484 MB); [ModelProbe.EXPECTED_SHA256] is displayed for the
 * on-device copy and `scripts/model.sh push` verifies it once after the push.
 */
sealed interface ModelStatus {
    val path: String

    /** Present at the pinned size — the only state in which the embedder is expected to open. */
    val isReady: Boolean get() = this is Present && bytes == ModelProbe.EXPECTED_BYTES

    /** The bundle is there. [bytes] is compared with the pinned size, never trusted blindly. */
    data class Present(override val path: String, val bytes: Long, val lastModified: Long = 0L) : ModelStatus

    /** E_NO_MODEL: nothing at [path] (not provisioned yet, or pushed to the wrong files dir). */
    data class Missing(override val path: String) : ModelStatus

    /** Something exists but cannot be opened (directory, permissions from an `adb push` as shell). */
    data class Unreadable(override val path: String, val reason: String) : ModelStatus
}

object ModelProbe {
    /** The honest status code the settings screen shows when there is no bundle (card B6). */
    const val E_NO_MODEL = "E_NO_MODEL"

    /** Size of `embeddinggemma-2-740m.litertlm` (docs/ARCHITECTURE.md; scripts/model.sh pins it too). */
    const val EXPECTED_BYTES = 484_622_336L

    /** sha256 of the pinned bundle; the same value EmbedderConfig and scripts/model.sh verify. */
    val EXPECTED_SHA256: String get() = EmbedderConfig.DEFAULT_MODEL_SHA256

    /** The hint shown next to E_NO_MODEL — the exact command that fixes it (card S6). */
    const val PUSH_HINT =
        "Push it with scripts/model.sh push <package> --dest internal (or --dest both), then re-open settings."

    /** Filesystem status of [file]. Never throws. */
    fun status(file: File): ModelStatus {
        val path = file.absolutePath
        return resolve(
            path = path,
            exists = file.exists(),
            isFile = file.isFile,
            readable = file.canRead(),
            bytes = if (file.isFile) file.length() else 0L,
            lastModified = file.lastModified(),
        )
    }

    /**
     * The whole decision without touching the disk, so the JVM tests can cover every branch without a
     * 484 MB fixture (the sha256/size pins are the reason this is not one expression in [status]).
     */
    internal fun resolve(
        path: String,
        exists: Boolean,
        isFile: Boolean,
        readable: Boolean,
        bytes: Long,
        lastModified: Long = 0L,
    ): ModelStatus = when {
        !exists -> ModelStatus.Missing(path)
        !isFile -> ModelStatus.Unreadable(path, "not a regular file")
        !readable -> ModelStatus.Unreadable(path, "not readable by this app (a shell-owned adb push — re-run scripts/model.sh push)")
        bytes <= 0L -> ModelStatus.Unreadable(path, "empty file")
        else -> ModelStatus.Present(path, bytes, lastModified)
    }

    /** "484,622,336 B · 462.2 MiB" */
    fun formatBytes(bytes: Long): String {
        val mib = bytes / (1024.0 * 1024.0)
        return String.format(Locale.ROOT, "%,d B · %.1f MiB", bytes, mib)
    }

    fun sizeMatches(bytes: Long): Boolean = bytes == EXPECTED_BYTES

    /** One line under the size: does it match the pinned bundle? */
    fun sizeNote(bytes: Long): String = if (sizeMatches(bytes)) {
        "matches the pinned bundle size"
    } else {
        "expected ${formatBytes(EXPECTED_BYTES)} — wrong or truncated bundle"
    }

    /** A one-line status for the UI; for [ModelStatus.Missing] it starts with [E_NO_MODEL]. */
    fun line(status: ModelStatus): String = when (status) {
        is ModelStatus.Present -> "present · ${formatBytes(status.bytes)} · ${sizeNote(status.bytes)}"
        is ModelStatus.Missing -> "$E_NO_MODEL · no bundle at ${status.path}"
        is ModelStatus.Unreadable -> "unreadable · ${status.reason}"
    }
}
