package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.rank.RANK_DIMS_ACTIVE
import dev.hajnina.scanlist.kotlin.scan.sources.Clock
import dev.hajnina.scanlist.kotlin.scan.sources.ScanSignal
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Card B5 review fixes at the controller seam — the two behaviours that only exist in the Android
 * glue and were therefore invisible to [ScanSessionTest]:
 *
 *  - a late OFF answer for barcode A must never repaint barcode B's UI strip (the ranking side was
 *    already guarded in `ScanSession.barcodeText`),
 *  - image coalescing keeps the **newest** pending frame while an embed is in flight (newest-frame-
 *    wins, matching the RN/web twins), not the older one that happened to be queued first.
 *
 * The controller is exercised with real coroutines on `Dispatchers.Default` (production lane) and
 * latches for the two races; the embedder/transport fakes are the same seams the other scan tests use.
 */
class ScanControllerTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val items = listOf(flatItem("a", "Milk", order = 0))
    private val vectors = mapOf("a" to axis(0, RANK_DIMS_ACTIVE))

    @After
    fun tearDown() {
        scope.cancel()
    }

    private class MutableClock(var now: Long = 1_000L) : Clock {
        override fun nowMs(): Long = now
    }

    private fun controller(
        embedder: QueryEmbedder = FakeQueryEmbedder(dims = RANK_DIMS_ACTIVE),
        resolver: OffResolver? = null,
        clock: Clock = MutableClock(),
    ): ScanController = ScanController(
        scope = scope,
        session = ScanSession(embedder = embedder),
        resolver = resolver,
        clock = clock,
        items = { items },
        vectors = { vectors },
        onTick = {},
        wallClockMs = { clock.nowMs() },
    )

    private fun cache() = OffCache(File(temp.newFolder("off"), "cache.json"))

    /** Poll instead of sleeping blindly: the work runs on the production `Dispatchers.Default` lane. */
    private fun await(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(5)
        }
        fail("timed out waiting for $what")
    }

    // ---------------------------------------------------------------- fix 1: strip binding

    /**
     * A's request blocks the IO lane; B is scanned and answered first; then A's answer lands late.
     * The strip must keep describing B — A's product name belongs to a pass the user already left.
     */
    @Test
    fun `a late OFF answer for barcode A never repaints barcode B strip`() {
        val a = "3017620422003"
        val b = "3017620425035"
        val transport = BlockingTransport(a)
        val resolver = OffResolver(cache(), transport, RequestThrottle(minSpacingMs = 0))
        val clock = MutableClock()
        val controller = controller(resolver = resolver, clock = clock)
        controller.start()

        controller.onSignal(ScanSignal.barcode(a, clock.nowMs()))
        assertTrue("A's lookup started", transport.aStarted.await(10, TimeUnit.SECONDS))

        clock.now += 100
        controller.onSignal(ScanSignal.barcode(b, clock.nowMs()))
        await("B's strip") {
            controller.barcodeUi.barcode == b && controller.barcodeUi.text == "B Product"
        }
        assertEquals(b, controller.view.barcode)

        transport.releaseA.countDown()
        assertTrue("A's request returned", transport.aReturned.await(10, TimeUnit.SECONDS))
        // The late answer is enqueued on the controller lane; give it (and any bug) time to land.
        Thread.sleep(500)

        assertEquals("the strip still describes B", b, controller.barcodeUi.barcode)
        assertEquals("B Product", controller.barcodeUi.text)
        assertEquals("the ranking pass still describes B", b, controller.view.barcode)
        assertNotEquals("A's text never reaches B's ranking", "A Product", controller.view.barcodeText)
    }

    // ---------------------------------------------------------------- fix 3: newest frame wins

    /** An image embed blocks; frames 2 and 3 arrive; after release the lane must embed frame 3. */
    @Test
    fun `the newest frame wins while an embed is in flight`() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val embedder = BlockingImageEmbedder(started, release)
        val clock = MutableClock()
        val controller = controller(embedder = embedder, clock = clock)
        controller.start()

        controller.onSignal(ScanSignal.image(byteArrayOf(1), clock.nowMs()))
        assertTrue("the first embed is in flight", started.await(10, TimeUnit.SECONDS))

        clock.now += 10
        controller.onSignal(ScanSignal.image(byteArrayOf(2), clock.nowMs()))
        clock.now += 10
        controller.onSignal(ScanSignal.image(byteArrayOf(3), clock.nowMs()))

        release.countDown()
        await("a second frame is embedded") { embedder.images.size >= 2 }
        Thread.sleep(100) // a stale queued frame would land right after the newest one

        assertEquals("frame 2 was superseded before it could embed", listOf(1, 3), embedder.images.toList())
    }

    // ---------------------------------------------------------------- fakes

    /** Answers B immediately; blocks A until the test releases it. */
    private class BlockingTransport(private val barcodeA: String) : OffTransport {
        val aStarted = CountDownLatch(1)
        val aReturned = CountDownLatch(1)
        val releaseA = CountDownLatch(1)
        val urls: MutableList<String> = Collections.synchronizedList(mutableListOf())

        override fun get(url: String, userAgent: String): OffHttp {
            urls += url
            return if (url.contains(barcodeA)) {
                aStarted.countDown()
                releaseA.await(10, TimeUnit.SECONDS)
                aReturned.countDown()
                OffHttp(200, body("A Product"))
            } else {
                OffHttp(200, body("B Product"))
            }
        }

        private fun body(name: String) =
            """{"status":1,"product":{"product_name":"$name"}}"""
    }

    /** Records the frame tag (its first byte) and blocks the first embed so a queue can build. */
    private class BlockingImageEmbedder(
        private val firstStarted: CountDownLatch,
        private val releaseFirst: CountDownLatch,
    ) : QueryEmbedder {
        override val dims: Int = RANK_DIMS_ACTIVE
        val images: MutableList<Int> = Collections.synchronizedList(mutableListOf())

        override fun text(text: String): DoubleArray = axis(0, RANK_DIMS_ACTIVE)

        override fun image(jpeg: ByteArray): DoubleArray? {
            val tag = jpeg.first().toInt()
            images += tag
            if (tag == 1) {
                firstStarted.countDown()
                releaseFirst.await(10, TimeUnit.SECONDS)
            }
            return axis(0, RANK_DIMS_ACTIVE)
        }
    }
}
