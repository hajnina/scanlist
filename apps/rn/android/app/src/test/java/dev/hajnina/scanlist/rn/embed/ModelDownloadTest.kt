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
    ) = ModelDownload(
        target = File(dir, "model.litertlm"),
        url = "https://example.invalid/model",
        expectedBytes = bytes,
        expectedSha256 = expectedSha,
        transport = transport,
        sleep = {},
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
}
