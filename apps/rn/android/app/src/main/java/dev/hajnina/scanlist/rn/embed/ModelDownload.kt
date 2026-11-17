package dev.hajnina.scanlist.rn.embed

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.Closeable
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * In-app download of the EmbeddingGemma 2 bundle (484 MB).
 *
 * The phone previously needed `scripts/model.sh push`; a fresh install therefore showed "model
 * missing" with no way forward. This is the one place that fetches the pinned bundle itself:
 *
 *  - resumable: one `.part` file next to the target, HTTP `Range: bytes=<len>-`;
 *  - retrying: IOException/timeouts back off 1/2/4/8… up to 30 s, forever while the app lives;
 *    403/404, a wrong pinned URL/sha, or too little free space are terminal (retrying cannot help);
 *  - verified: exact byte size + sha256 before the atomic `.part` → final rename;
 *  - observable: [status] is a cheap snapshot the bridge returns from `status()`; `start()` publishes
 *    DOWNLOADING synchronously, so the first status poll after mount already sees the work;
 *
 * The core is transport- and clock-injectable so JVM unit tests cover the state machine without a
 * network or a 484 MB fixture (see `app/src/test/.../ModelDownloadTest.kt`).
 */
internal enum class DownloadState { IDLE, DOWNLOADING, VERIFYING, READY, FAILED }

internal data class DownloadStatus(
    val state: DownloadState = DownloadState.IDLE,
    val bytes: Long = 0,
    val total: Long = 0,
    val pct: Int = 0,
    val error: String? = null,
) {
    /** The map shape `EmbedModule.status()` hands to JS (`download: {state, bytes, total, pct, error}`). */
    fun asMap(): Map<String, Any?> = mapOf(
        "state" to state.name.lowercase(),
        "bytes" to bytes,
        "total" to total,
        "pct" to pct,
        "error" to error,
    )
}

/** One HTTP attempt, abstracted so tests use a fake instead of the network. */
internal interface DownloadTransport {
    /** Opens [url] with `Range: bytes=<offset>-`. The caller closes the response. */
    fun open(url: String, offset: Long): Response

    class Response(
        val code: Int,
        val body: InputStream?,
        /** Body length as announced by the server, or -1 when unknown. */
        val contentLength: Long,
        /** `Content-Range` header verbatim (`bytes 4000-9999/10000`), or null. */
        val contentRange: String? = null,
    ) : Closeable {
        override fun close() {
            body?.close()
        }
    }
}

/** `HttpURLConnection` is already in the platform: no new dependency. */
internal class HttpDownloadTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : DownloadTransport {
    override fun open(url: String, offset: Long): DownloadTransport.Response {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            setRequestProperty("User-Agent", "ScanList-RN")
            if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
        }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        return DownloadTransport.Response(
            code,
            stream,
            connection.contentLengthLong,
            connection.getHeaderField("Content-Range"),
        )
    }
}

/** Thrown for states retrying cannot fix (404/403, sha mismatch twice, unwritable dir). */
internal class TerminalDownloadException(message: String) : Exception(message)

/**
 * The state machine. One instance per process (see [ModelDownloads]); [run] blocks until READY or
 * FAILED, so it is only ever called on a background thread.
 */
internal class ModelDownload(
    private val target: File,
    private val url: String,
    private val expectedBytes: Long,
    private val expectedSha256: String,
    private val transport: DownloadTransport = HttpDownloadTransport(),
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val onUpdate: (DownloadStatus) -> Unit = {},
    /** Usable bytes on [target]'s volume; injected because `StatFs` is an Android stub on the JVM. */
    private val usableBytes: () -> Long = { usableSpaceOn(target) },
    /**
     * Runs the download body. Injected only by tests, which capture the body instead of running it
     * on a thread — that is how "start() published before the worker ran" is asserted deterministically.
     */
    private val launch: (() -> Unit) -> Unit = { body ->
        Thread(body, "scanlist-model-download").apply { isDaemon = true }.start()
    },
) {
    val part: File = File(target.parentFile, target.name + ".part")

    @Volatile
    var status: DownloadStatus = DownloadStatus(total = expectedBytes)
        private set

    private val running = AtomicBoolean(false)

    /** A bundle already on disk (any EmbedModel layout): report READY without downloading. */
    fun adoptExisting() {
        publish(DownloadStatus(DownloadState.READY, target.length(), expectedBytes, 100))
    }

    /** Starts [run] at most once; repeated calls are no-ops (the second `status()` must not restart). */
    fun start(): Boolean {
        if (target.isFile) {
            publish(DownloadStatus(DownloadState.READY, expectedBytes, expectedBytes, 100))
            return false
        }
        if (!running.compareAndSet(false, true)) return false
        shaRestarts = 0
        rangeRestarts = 0
        target.parentFile?.mkdirs()
        // MODELDL fix 2: a full phone looped the transient retry forever with the UI stuck at
        // "Downloading model… X%" (and the `.part` never growing). Space is something only the user
        // can fix, so it is terminal: one clear FAILED, no backoff.
        val shortage = spaceShortage()
        if (shortage != null) {
            running.set(false)
            fail(shortage)
            return false
        }
        // MODELDL fix 4 (the cold-start race): publish BEFORE the worker exists. JS re-polls only
        // while the snapshot says downloading/verifying (`useScanGuidance.ts`), so an IDLE first
        // answer froze the adb-push hint for the whole 484 MB session. From here the state machine
        // is honest: a download really is in progress.
        val offset = existingPartBytes()
        publish(DownloadStatus(DownloadState.DOWNLOADING, offset, expectedBytes, pct(offset)))
        launch {
            try {
                run()
            } finally {
                running.set(false)
            }
        }
        return true
    }

    /** Visible for the JVM state-machine tests. Blocks until READY/FAILED. */
    internal fun run() {
        // Both restart counters are per-run: a fresh start() gets its own budget.
        shaRestarts = 0
        rangeRestarts = 0
        while (true) {
            try {
                downloadOnce()
                return
            } catch (t: TerminalDownloadException) {
                fail(t.message ?: "download failed")
                return
            } catch (e: InterruptedException) {
                return
            } catch (t: Throwable) {
                // Transient: keep the `.part`, back off, try again. The app may stay open for hours.
                val attempt = attemptOf(t)
                val delay = backoffMs(attempt)
                publish(status.copy(state = DownloadState.DOWNLOADING, error = t.message))
                try {
                    sleep(delay)
                } catch (e: InterruptedException) {
                    return
                }
            }
        }
    }

    private var attempts = 0

    private fun attemptOf(@Suppress("UNUSED_PARAMETER") t: Throwable): Int {
        attempts += 1
        return attempts
    }

    /** 1/2/4/8 s …, capped at 30 s, forever. */
    private fun backoffMs(attempt: Int): Long {
        val shift = (attempt - 1).coerceIn(0, 4)
        return minOf(30_000L, 1_000L shl shift)
    }

    /** Mismatch budget: one cold re-download, then terminal. */
    private var shaRestarts = 0

    /** Wrong/absent Content-Range budget: one restart from zero, then terminal. */
    private var rangeRestarts = 0

    private fun downloadOnce() {
        target.parentFile?.mkdirs()
        if (target.isFile) {
            publish(DownloadStatus(DownloadState.READY, expectedBytes, expectedBytes, 100))
            return
        }
        // MODELDL fix 2, resume path: the volume can fill while the app lives (the scanner writes
        // ~100-200 KB per sampled frame), so re-check at every attempt — one `StatFs` call is cheap.
        spaceShortage()?.let { throw TerminalDownloadException(it) }
        var offset = if (part.isFile) part.length() else 0L
        if (offset > expectedBytes) {
            part.delete()
            offset = 0
        }
        publish(DownloadStatus(DownloadState.DOWNLOADING, offset, expectedBytes, pct(offset)))

        if (offset < expectedBytes) {
            transport.open(url, offset).use { response ->
                val body = response.body
                when (response.code) {
                    200 -> {
                        // Server ignored Range: the only honest thing is to start over.
                        part.delete()
                        offset = 0
                        if (body == null) throw IOException("HTTP 200 with no body")
                        // A full body must be exactly the bundle when the server says how big it is.
                        if (response.contentLength >= 0 && response.contentLength != expectedBytes) {
                            throw IOException(
                                "HTTP 200 body is ${response.contentLength}B, expected ${expectedBytes}B",
                            )
                        }
                        copyToPart(body, offset)
                    }
                    206 -> {
                        if (body == null) throw IOException("HTTP 206 with no body")
                        validatePartial(response, offset)
                        copyToPart(body, offset)
                    }
                    403, 404 -> throw TerminalDownloadException(
                        "HTTP ${response.code} fetching the model — check the pinned URL",
                    )
                    else -> throw IOException("HTTP ${response.code} fetching the model")
                }
            }
        }

        val size = part.length()
        if (size != expectedBytes) {
            if (size > expectedBytes) {
                part.delete()
                throw IOException("downloaded ${size}B, expected ${expectedBytes}B — restarting")
            }
            // Short body: the next attempt resumes from `size`.
            publish(status.copy(state = DownloadState.DOWNLOADING, bytes = size, pct = pct(size)))
            throw IOException("short body: ${size}B of ${expectedBytes}B")
        }

        publish(DownloadStatus(DownloadState.VERIFYING, size, expectedBytes, 100))
        val digest = sha256(part)
        if (!digest.equals(expectedSha256, ignoreCase = true)) {
            part.delete()
            if (shaRestarts >= 1) {
                throw TerminalDownloadException(
                    "sha256 mismatch after a full re-download (${digest.take(12)}…) — " +
                        "the pinned URL or hash is wrong",
                )
            }
            shaRestarts += 1
            publish(
                DownloadStatus(
                    DownloadState.DOWNLOADING,
                    0,
                    expectedBytes,
                    0,
                    "sha256 mismatch (${digest.take(12)}…) — retrying from zero",
                ),
            )
            throw IOException("sha256 mismatch — restarting from zero once")
        }

        if (!part.renameTo(target)) {
            throw TerminalDownloadException("cannot move the verified bundle to ${target.absolutePath}")
        }
        publish(DownloadStatus(DownloadState.READY, expectedBytes, expectedBytes, 100))
    }

    /**
     * A `206` is only trustworthy when it says it starts exactly where our `.part` ends and carries
     * the remaining bytes. A proxy/CDN that ignores `Range` or answers from another offset would
     * otherwise splice two different byte ranges into one corrupt 484 MB file.
     */
    private fun validatePartial(response: DownloadTransport.Response, offset: Long) {
        val range = parseContentRange(response.contentRange)
        val wrong =
            range == null ||
                range.start != offset ||
                (range.total >= 0 && range.total != expectedBytes) ||
                (response.contentLength >= 0 &&
                    response.contentLength != expectedBytes - offset)
        if (!wrong) return

        part.delete()
        rangeRestarts += 1
        publish(
            DownloadStatus(
                DownloadState.DOWNLOADING,
                0,
                expectedBytes,
                0,
                "server answered 206 for the wrong range (${response.contentRange ?: "no Content-Range"})" +
                    " — restarting from zero",
            ),
        )
        if (rangeRestarts >= 2) {
            throw TerminalDownloadException(
                "server keeps answering 206 for the wrong range " +
                    "(${response.contentRange ?: "no Content-Range"}); expected bytes $offset-${expectedBytes - 1}",
            )
        }
        throw IOException("206 Content-Range mismatch — restarting from zero once")
    }

    /** `bytes <start>-<end>/<total>`; total is -1 for `*`. */
    private data class ContentRange(val start: Long, val end: Long, val total: Long)

    private fun parseContentRange(header: String?): ContentRange? {
        val match = RANGE_PATTERN.matchEntire(header?.trim() ?: return null) ?: return null
        val start = match.groupValues[1].toLongOrNull() ?: return null
        val end = match.groupValues[2].toLongOrNull() ?: return null
        val total = if (match.groupValues[3] == "*") -1L else match.groupValues[3].toLongOrNull() ?: return null
        if (start < 0 || end < start) return null
        return ContentRange(start, end, total)
    }

    /** Bytes already downloaded into the `.part` (clamped: a stale oversized part restarts at zero). */
    private fun existingPartBytes(): Long =
        if (part.isFile) part.length().coerceIn(0, expectedBytes) else 0

    /**
     * MODELDL fix 2: `null` when the target volume can hold the bytes still missing plus
     * [FREE_SPACE_MARGIN_BYTES] of headroom (the `.part` fsync, the rename, and the OS's own writes
     * need slack). A `usableBytes` that throws means "unknown", which never blocks a download.
     */
    private fun spaceShortage(): String? {
        val missing = (expectedBytes - existingPartBytes()).coerceAtLeast(0)
        val need = missing + FREE_SPACE_MARGIN_BYTES
        val have = runCatching { usableBytes() }.getOrDefault(Long.MAX_VALUE)
        if (have >= need) return null
        return "not enough free space: need ${mib(need)} " +
            "(${mib(missing)} still to download + ${mib(FREE_SPACE_MARGIN_BYTES)} margin), " +
            "${mib(have)} available"
    }

    private fun mib(bytes: Long): String =
        String.format(java.util.Locale.US, "%.0f MiB", bytes / 1_048_576.0)

    private fun copyToPart(body: InputStream, offset: Long) {
        // Append for a resumed transfer; truncate when the server restarted us at zero.
        java.io.FileOutputStream(part, offset > 0).use { out ->
            val buffer = ByteArray(BUFFER_BYTES)
            var written = offset
            while (true) {
                val read = body.read(buffer)
                if (read < 0) break
                out.write(buffer, 0, read)
                written += read
                publish(
                    DownloadStatus(
                        DownloadState.DOWNLOADING,
                        written,
                        expectedBytes,
                        pct(written),
                    ),
                )
            }
            out.flush()
            out.fd.sync()
        }
    }

    private fun publish(next: DownloadStatus) {
        status = next
        runCatching { onUpdate(next) }
    }

    private fun fail(error: String) {
        publish(DownloadStatus(DownloadState.FAILED, part.length(), expectedBytes, pct(part.length()), error))
    }

    private fun pct(bytes: Long): Int =
        if (expectedBytes <= 0) 0 else ((bytes * 100) / expectedBytes).toInt().coerceIn(0, 100)

    companion object {
        /**
         * MODELDL fix 1 — the bundle's immutable revision on Hugging Face. `/resolve/main/` would
         * silently track a future upload: sha mismatch ⇒ one cold 484 MB retry ⇒ terminal FAILED
         * (and the settings copy then lost the adb remedy). Re-pin URL + [MODEL_SHA256] +
         * [MODEL_BYTES] together when the bundle changes:
         *   curl -s "https://huggingface.co/api/models/litert-community/embeddinggemma-2-740m-litert-lm/revision/main"
         * Verified 2026-11-17: sha 66011bd4…, file 484622336 B, lfs sha256 e7a8a220…7f4c.
         */
        const val MODEL_REVISION = "66011bd4f00a8b36a1d3c4ae7bf908b4891b4881"

        const val MODEL_URL =
            "https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/" +
                MODEL_REVISION + "/embeddinggemma-2-740m.litertlm"

        /** Pinned by `scripts/model.sh` / `EmbedderConfig.DEFAULT_MODEL_SHA256`. */
        const val MODEL_SHA256 = "e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c"

        const val MODEL_BYTES = 484_622_336L

        /** Headroom demanded on top of the missing bytes (filesystem/rename/OS writes). */
        const val FREE_SPACE_MARGIN_BYTES = 512L * 1024 * 1024

        /** Usable bytes on [target]'s volume. Unreadable volumes read as "plenty" (never block). */
        internal fun usableSpaceOn(target: File): Long {
            val dir = target.parentFile ?: return Long.MAX_VALUE
            return runCatching { android.os.StatFs(dir.absolutePath).availableBytes }
                .getOrDefault(Long.MAX_VALUE)
        }

        private const val BUFFER_BYTES = 256 * 1024

        private val RANGE_PATTERN = Regex("""bytes (\d+)-(\d+)/(\d+|\*)""")

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(BUFFER_BYTES)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/** The process-wide instance: `status()` must never start a second download. */
internal object ModelDownloads {
    @Volatile private var current: ModelDownload? = null

    fun get(context: android.content.Context): ModelDownload {
        current?.let { return it }
        return synchronized(this) {
            current ?: run {
                // A device provisioned with `scripts/model.sh push` may hold the bundle in ANY of
                // EmbedModel's layouts (internal or external files dir). Adopt it: never burn a
                // second 484 MB download just because the first candidate is empty.
                val existing = EmbedModel.find(context)
                ModelDownload(
                    target = existing ?: EmbedModel.candidates(context).first(),
                    url = ModelDownload.MODEL_URL,
                    expectedBytes = ModelDownload.MODEL_BYTES,
                    expectedSha256 = ModelDownload.MODEL_SHA256,
                ).also {
                    current = it
                    if (existing != null) {
                        it.adoptExisting()
                    } else {
                        it.start()
                    }
                }
            }
        }
    }
}
