package dev.hajnina.scanlist.rn.embed

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout

/**
 * JVM tests for the model download state machine: no network, no 484 MB fixture.
 *
 * Every test has a hard 5 s timeout: a retry loop that never terminates must fail the suite, not
 * hang CI. (The fake transport also never sleeps — the injected `sleep` is a no-op.)
 */
class ModelDownloadTest {

    @get:Rule
    val timeout: Timeout = Timeout.seconds(5)

    private val payload = ByteArray(10_000) { (it % 251).toByte() }
    private val sha = sha256(payload)

    private fun sha256(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private fun dir(): File = Files.createTempDirectory("modeldl-test").toFile()

    /** Serves [payload] with correct Range support or deliberately broken behaviour. */
    private class FakeTransport(
        private val payload: ByteArray,
        private val mode: Mode,
    ) : DownloadTransport {
        enum class Mode { RANGE, IGNORE_RANGE, NOT_FOUND, WRONG_RANGE }
        val offsets = mutableListOf<Long>()

        override fun open(url: String, offset: Long): DownloadTransport.Response {
            offsets.add(offset)
            if (mode == Mode.NOT_FOUND) {
                return DownloadTransport.Response(404, ByteArrayInputStream(ByteArray(0)), 0)
            }
            val start = when (mode) {
                Mode.IGNORE_RANGE -> 0
                Mode.WRONG_RANGE -> (offset + 1).coerceAtMost(payload.size.toLong())
                else -> offset
            }
            val slice = payload.copyOfRange(start.toInt(), payload.size)
            val code = if (mode == Mode.IGNORE_RANGE || offset == 0L) 200 else 206
            val range = if (code == 206) {
                "bytes $start-${payload.size - 1}/${payload.size}"
            } else {
                null
            }
            return DownloadTransport.Response(
                code,
                ByteArrayInputStream(slice),
                slice.size.toLong(),
                range,
            )
        }
    }

    private fun downloader(
        dir: File,
        transport: DownloadTransport,
        bytes: Long = payload.size.toLong(),
        expectedSha: String = sha,
        usable: () -> Long = { Long.MAX_VALUE },
        launch: (() -> Unit) -> Unit = { it() },
    ) = ModelDownload(
        target = File(dir, "model.litertlm"),
        url = "https://example.invalid/model",
        expectedBytes = bytes,
        expectedSha256 = expectedSha,
        transport = transport,
        sleep = {},
        usableBytes = usable,
        launch = launch,
    )

    @Test
    fun `fresh download writes part then renames atomically`() {
        val dir = dir()
        val model = downloader(dir, FakeTransport(payload, FakeTransport.Mode.RANGE))
        model.run()
        assertEquals(DownloadState.READY, model.status.state)
        assertEquals(100, model.status.pct)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
        assertFalse(model.part.exists())
    }

    @Test
    fun `resume appends from an existing part using a validated Range`() {
        val dir = dir()
        File(dir, "model.litertlm.part").writeBytes(payload.copyOfRange(0, 4_000))
        val transport = FakeTransport(payload, FakeTransport.Mode.RANGE)
        val model = downloader(dir, transport)
        model.run()
        assertEquals(DownloadState.READY, model.status.state)
        // One attempt at exactly the part length, and its Content-Range was accepted.
        assertEquals(listOf(4_000L), transport.offsets)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
    }

    @Test
    fun `server ignoring Range restarts from zero`() {
        val dir = dir()
        File(dir, "model.litertlm.part").writeBytes(ByteArray(4_000) { 7 })
        val model = downloader(dir, FakeTransport(payload, FakeTransport.Mode.IGNORE_RANGE))
        model.run()
        assertEquals(DownloadState.READY, model.status.state)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
    }

    @Test
    fun `206 from the wrong offset restarts from zero and then succeeds`() {
        val dir = dir()
        File(dir, "model.litertlm.part").writeBytes(payload.copyOfRange(0, 4_000))
        var call = 0
        val transport = object : DownloadTransport {
            override fun open(url: String, offset: Long): DownloadTransport.Response {
                call += 1
                if (call == 1) {
                    // Asked for 4000-, answered with 0-9999: a proxy that ignored the range.
                    return DownloadTransport.Response(
                        206,
                        ByteArrayInputStream(payload),
                        payload.size.toLong(),
                        "bytes 0-${payload.size - 1}/${payload.size}",
                    )
                }
                return DownloadTransport.Response(200, ByteArrayInputStream(payload), payload.size.toLong())
            }
        }
        val model = downloader(dir, transport)
        model.run()
        assertEquals(DownloadState.READY, model.status.state)
        assertEquals(2, call)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
    }

    @Test
    fun `repeated wrong-range 206 fails terminally instead of looping`() {
        val dir = dir()
        File(dir, "model.litertlm.part").writeBytes(payload.copyOfRange(0, 4_000))
        val transport = object : DownloadTransport {
            override fun open(url: String, offset: Long): DownloadTransport.Response {
                // Always 206 from one byte past the asked offset: never a valid resume.
                val start = (offset + 1).coerceAtMost(payload.size.toLong()).toInt()
                val slice = payload.copyOfRange(start, payload.size)
                return DownloadTransport.Response(
                    206,
                    ByteArrayInputStream(slice),
                    slice.size.toLong(),
                    "bytes $start-${payload.size - 1}/${payload.size}",
                )
            }
        }
        val model = downloader(dir, transport)
        model.run()
        assertEquals(DownloadState.FAILED, model.status.state)
        assertNotNull(model.status.error)
        assertFalse(File(dir, "model.litertlm").exists())
    }

    @Test
    fun `sha mismatch retries once from zero then succeeds`() {
        val dir = dir()
        var call = 0
        val transport = object : DownloadTransport {
            override fun open(url: String, offset: Long): DownloadTransport.Response {
                call += 1
                val body = if (call == 1) ByteArray(payload.size) { 1 } else payload
                return DownloadTransport.Response(200, ByteArrayInputStream(body), body.size.toLong())
            }
        }
        val model = downloader(dir, transport)
        model.run()
        assertEquals(DownloadState.READY, model.status.state)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
    }

    @Test
    fun `sha mismatch twice fails terminally with a clear error`() {
        val dir = dir()
        var calls = 0
        val bad = object : DownloadTransport {
            override fun open(url: String, offset: Long): DownloadTransport.Response {
                calls += 1
                return DownloadTransport.Response(
                    200,
                    ByteArrayInputStream(ByteArray(payload.size) { 1 }),
                    payload.size.toLong(),
                )
            }
        }
        val model = downloader(dir, bad)
        model.run()
        assertEquals(DownloadState.FAILED, model.status.state)
        assertNotNull(model.status.error)
        assertTrue(model.status.error!!.contains("sha256 mismatch"))
        assertEquals(2, calls) // first download + exactly one cold restart
        assertFalse(File(dir, "model.litertlm").exists())
        assertFalse(model.part.exists())
    }

    @Test
    fun `404 is terminal and does not retry`() {
        val dir = dir()
        val transport = FakeTransport(payload, FakeTransport.Mode.NOT_FOUND)
        val model = downloader(dir, transport)
        model.run()
        assertEquals(DownloadState.FAILED, model.status.state)
        assertTrue(model.status.error!!.contains("404"))
        assertEquals(1, transport.offsets.size)
    }

    @Test
    fun `truncated body keeps the part for the next resume`() {
        val dir = dir()
        var call = 0
        val transport = object : DownloadTransport {
            override fun open(url: String, offset: Long): DownloadTransport.Response {
                call += 1
                // First response lies short; second serves exactly the remaining bytes.
                val end = if (call == 1) 3_000 else payload.size
                val slice = payload.copyOfRange(offset.toInt(), end)
                val range =
                    if (offset > 0) "bytes $offset-${payload.size - 1}/${payload.size}" else null
                return DownloadTransport.Response(
                    if (offset == 0L) 200 else 206,
                    ByteArrayInputStream(slice),
                    slice.size.toLong(),
                    range,
                )
            }
        }
        val model = downloader(dir, transport)
        model.run()
        assertEquals(DownloadState.READY, model.status.state)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
    }

    // ---------------------------------------------------------------- MODELDL review fixes

    /** MODELDL fix 1 (mutation c): an unpinned `/resolve/main/` URL must not come back. */
    @Test
    fun `model URL is pinned to the immutable revision that holds the pinned sha`() {
        val url = ModelDownload.MODEL_URL
        assertEquals(
            "https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/" +
                "66011bd4f00a8b36a1d3c4ae7bf908b4891b4881/embeddinggemma-2-740m.litertlm",
            url,
        )
        assertFalse("a moving branch would break the sha pin", url.contains("/resolve/main/"))
        // The pin is only meaningful together: revision + size + sha belong to the same upload.
        assertEquals("66011bd4f00a8b36a1d3c4ae7bf908b4891b4881", ModelDownload.MODEL_REVISION)
        assertEquals(484_622_336L, ModelDownload.MODEL_BYTES)
        assertEquals(
            "e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c",
            ModelDownload.MODEL_SHA256,
        )
    }

    /** MODELDL fix 2 (mutation a): a full phone is terminal at start(), not an endless retry loop. */
    @Test
    fun `no free space fails terminally at start and never opens the transport`() {
        val dir = dir()
        val transport = FakeTransport(payload, FakeTransport.Mode.RANGE)
        val need = payload.size + ModelDownload.FREE_SPACE_MARGIN_BYTES
        var launches = 0
        val model = downloader(
            dir,
            transport,
            usable = { need - 1 },
            launch = { launches += 1 },
        )
        assertFalse(model.start())
        assertEquals(DownloadState.FAILED, model.status.state)
        assertTrue(model.status.error!!.contains("not enough free space"))
        assertEquals(0, launches) // no worker thread for a state only the user can fix
        assertTrue(transport.offsets.isEmpty())
        assertFalse(File(dir, "model.litertlm").exists())
    }

    /** MODELDL fix 2, resume path: space is re-checked on every attempt (the volume can fill). */
    @Test
    fun `resume attempt re-checks free space and fails terminally when the volume filled`() {
        val dir = dir()
        File(dir, "model.litertlm.part").writeBytes(payload.copyOfRange(0, 4_000))
        val transport = FakeTransport(payload, FakeTransport.Mode.RANGE)
        val missing = payload.size - 4_000L
        val model = downloader(
            dir,
            transport,
            usable = { missing + ModelDownload.FREE_SPACE_MARGIN_BYTES - 1 },
        )
        model.run()
        assertEquals(DownloadState.FAILED, model.status.state)
        assertTrue(model.status.error!!.contains("not enough free space"))
        assertTrue(transport.offsets.isEmpty())
    }

    /** MODELDL fix 4 (mutation b): the first status() after mount must already say downloading. */
    @Test
    fun `start publishes downloading synchronously before the worker runs`() {
        val dir = dir()
        val transport = FakeTransport(payload, FakeTransport.Mode.RANGE)
        var body: (() -> Unit)? = null
        val model = downloader(dir, transport, launch = { body = it })
        assertTrue(model.start())
        // The worker has NOT run yet: only start()'s own publish can have produced this state.
        assertEquals(DownloadState.DOWNLOADING, model.status.state)
        assertEquals(0, model.status.bytes)
        assertEquals(payload.size.toLong(), model.status.total)
        assertNotNull(body)
        body!!.invoke()
        assertEquals(DownloadState.READY, model.status.state)
        assertArrayEquals(payload, File(dir, "model.litertlm").readBytes())
    }

    /** MODELDL fix 6: two start() calls ⇒ one download; the second joins, it does not duplicate. */
    @Test
    fun `two start calls run exactly one download`() {
        val dir = dir()
        val transport = FakeTransport(payload, FakeTransport.Mode.RANGE)
        var launches = 0
        var body: (() -> Unit)? = null
        val model = downloader(
            dir,
            transport,
            launch = {
                launches += 1
                body = it
            },
        )
        assertTrue(model.start())
        assertFalse("second start must join the running download", model.start())
        assertFalse("third start is still a no-op", model.start())
        assertEquals(1, launches)
        body!!.invoke()
        assertEquals(DownloadState.READY, model.status.state)
        assertEquals("one HTTP transfer", 1, transport.offsets.size)
        // Once the bundle is on disk, a later start() adopts it instead of restating the thread.
        assertFalse(model.start())
        assertEquals(1, transport.offsets.size)
    }
}
