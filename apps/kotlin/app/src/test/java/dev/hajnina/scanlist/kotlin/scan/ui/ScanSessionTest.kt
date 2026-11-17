package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.rank.RankTicker
import dev.hajnina.scanlist.kotlin.scan.sources.ScanSignal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The magic scan's heart (card B5): signals → queries → `RankTicker` → the view. The rules under test
 * are the ones the screen must never bend:
 *  - the hero is whatever `decideTop` returned (a null hero is rendered honestly, never faked),
 *  - the barcode's OFF text owns slot one of the 16 text queries (B4-sync's risk),
 *  - one tick ends the pass: the hero waits for the next *product*, not for the next frame,
 *  - sensor-oriented frames are rotated upright before embedding,
 *  - expiry and embedder failures degrade to the honest "no signal" states.
 */
class ScanSessionTest {

    private val items = listOf(
        flatItem("a", "Milk", order = 0),
        flatItem("b", "Oat milk", order = 1),
        flatItem("c", "Bread", order = 2),
    )

    private val vectors = mapOf(
        "a" to axis(0),
        "b" to axis(1),
        "c" to axis(2),
    )

    private val textVectors = mapOf(
        "Milk" to axis(0),
        "Oat milk" to axis(1),
        "Bread" to axis(2),
    )

    private fun text(text: String) = ScanSignal.text(text, 0)

    private fun embedder(
        image: (ByteArray) -> DoubleArray? = { null },
    ) = FakeQueryEmbedder(dims = 4, textVectors = textVectors, imageVectors = image)

    private fun session(
        queryEmbedder: QueryEmbedder = embedder(),
        rotator: ImageRotator = ImageRotator.NONE,
        ticker: RankTicker = RankTicker(minIntervalMs = 0, dims = 4),
    ) = ScanSession(embedder = queryEmbedder, rotator = rotator, ticker = ticker, dims = 4)

    // ---------------------------------------------------------------- states

    @Test
    fun `the initial view is NO_LIST and a scan start shows flatten order unranked`() {
        val session = session()
        assertEquals(ScanStatus.NO_LIST, session.view.status)
        assertNull(session.view.hero)

        val started = session.start(items, vectors, nowMs = 0)
        assertEquals(ScanStatus.NO_SIGNAL, started.status)
        assertEquals(listOf("a", "b", "c"), started.rows.map { it.id })
        assertFalse(started.ranked)
        assertNull(started.hero)
        assertNotNull(started.message)
        assertFalse(started.chips.any)
    }

    @Test
    fun `an empty list is LIST_EMPTY`() {
        val view = session().start(emptyList(), emptyMap(), nowMs = 0)
        assertEquals(ScanStatus.LIST_EMPTY, view.status)
        assertTrue(view.rows.isEmpty())
        assertNull(view.hero)
        assertNotNull(view.message)
    }

    @Test
    fun `missing item vectors keep the flatten order and say why`() {
        val session = session()
        val noVectors = session.start(items, null, nowMs = 0)
        assertEquals(ScanStatus.NO_VECTORS, noVectors.status)
        assertEquals(listOf("a", "b", "c"), noVectors.rows.map { it.id })
        assertNull(noVectors.hero)

        // A live signal cannot rank against missing item vectors either.
        assertEquals(ScanStatus.NO_VECTORS, session.signal(text("Milk"), nowMs = 1).status)
        assertEquals(listOf("a", "b", "c"), session.view.rows.map { it.id })
    }

    @Test
    fun `an embedder failure is surfaced, not swallowed`() {
        val failing = embedder().also { it.error = "native library missing" }
        val view = session(queryEmbedder = failing).start(items, null, nowMs = 0)
        assertEquals(ScanStatus.NO_VECTORS, view.status)
        assertEquals("native library missing", view.error)
        assertEquals("native library missing", view.message)
    }

    // ---------------------------------------------------------------- hero from the ranker

    @Test
    fun `a confident text match becomes the hero and leaves the rows`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        val view = session.signal(text("Milk"), nowMs = 0)

        assertEquals(ScanStatus.HERO, view.status)
        assertEquals("a", view.hero!!.id)
        assertEquals("Milk", view.hero.name)
        assertEquals(1.0, view.hero.score, 1e-9)
        assertNull(view.message)
        assertTrue(view.ranked)
        assertEquals(listOf("b", "c"), view.rows.map { it.id })
        assertTrue("the TEXT chip lights up", view.chips.text)
        assertFalse(view.chips.barcode)
    }

    @Test
    fun `a near tie is NO_HERO - the 0,05 margin is the ranker's, never the UI's`() {
        val nearTieItems = listOf(
            flatItem("a", "Milk", order = 0),
            flatItem("d", "Milky drink", order = 1),
        )
        val nearTieVectors = mapOf(
            "a" to axis(0),
            "d" to doubleArrayOf(0.99, 0.140714, 0.0, 0.0),
        )
        val session = session()
        session.start(nearTieItems, nearTieVectors, nowMs = 0)
        val view = session.signal(text("Milk"), nowMs = 0)

        assertTrue("it is ranked", view.ranked)
        assertNull("scores 1.0 vs 0.99 are not decisive", view.hero)
        assertEquals(ScanStatus.NO_HERO, view.status)
        assertEquals(listOf("a", "d"), view.rows.map { it.id })
        assertTrue(view.message!!.contains("Nothing confident yet"))
    }

    @Test
    fun `a zero score query is NO_HERO with honest copy, and the barcode name is quoted`() {
        val blind = FakeQueryEmbedder(dims = 4, textVectors = emptyMap())
        val session = session(queryEmbedder = blind)
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.barcode("3017620422003", 0), nowMs = 0)
        val view = session.barcodeText("Mystery spread", "3017620422003", nowMs = 1)

        assertEquals(ScanStatus.NO_HERO, view.status)
        assertNull(view.hero)
        assertEquals("3017620422003", view.barcode)
        assertEquals("Mystery spread", view.barcodeText)
        assertTrue("the copy names the product OFF answered for", view.message!!.contains("Mystery spread"))
        assertEquals(listOf("a", "b", "c"), view.rows.map { it.id })
    }

    @Test
    fun `an image-only winner needs the barcode accept-list confirmation`() {
        val session = session(queryEmbedder = embedder(image = { axis(0) }))
        session.start(items, vectors, nowMs = 0)
        val frame = ScanSignal.image(byteArrayOf(1, 2, 3), atMs = 1)

        val imageOnly = session.signal(frame, nowMs = 1)
        assertTrue(imageOnly.ranked)
        assertNull("no barcode name, so no confirmed item", imageOnly.hero)
        assertEquals(ScanStatus.NO_HERO, imageOnly.status)

        val barcodeOnly = session.signal(ScanSignal.barcode("3017620422003", 2), nowMs = 2)
        assertNull("digits alone do not confirm a name", barcodeOnly.hero)

        val confirmed = session.barcodeText("Milk", "3017620422003", nowMs = 3)
        assertEquals(ScanStatus.HERO, confirmed.status)
        assertEquals("a", confirmed.hero!!.id)
    }

    @Test
    fun `one noisy frame does not move the confirmed hero away`() {
        // Frame byte 1 points mostly at "a" (0.8 / 0.6), frame byte 2 points exactly at "b".
        val noisy = embedder(image = { jpeg ->
            if (jpeg.last() == 1.toByte()) {
                doubleArrayOf(0.8, 0.6, 0.0, 0.0)
            } else {
                axis(1)
            }
        })
        val session = session(queryEmbedder = noisy)
        session.start(items, vectors, nowMs = 0)
        session.signal(text("Milk"), nowMs = 0)
        assertEquals("a", session.view.hero!!.id)

        // A frame pointing mostly at "a" changes nothing.
        val mostly = ScanSignal.image(byteArrayOf(1), atMs = 1)
        assertEquals("a", session.signal(mostly, nowMs = 1).hero!!.id)

        // A frame pointing exactly at "b": EMA(0.5) lifts b only to 0.8 while the text evidence keeps
        // a at 1.0, so the hero does not flip on a single frame.
        val other = session.signal(
            ScanSignal.image(byteArrayOf(2), atMs = 2),
            nowMs = 2,
        )
        assertEquals(ScanStatus.HERO, other.status)
        assertEquals("a", other.hero!!.id)
        assertEquals(1.0, other.hero.score, 1e-9)
    }

    @Test
    fun `done items are grouped, never scored`() {
        val withDone = listOf(
            flatItem("a", "Milk", order = 0),
            flatItem("b", "Oat milk", order = 1, done = true),
            flatItem("c", "Bread", order = 2),
        )
        val session = session()
        session.start(withDone, vectors, nowMs = 0)
        val view = session.signal(text("Milk"), nowMs = 0)

        assertEquals(ScanStatus.HERO, view.status)
        assertEquals("a", view.hero!!.id)
        assertEquals(listOf("c"), view.rows.map { it.id })
        assertEquals(listOf("b"), view.done.map { it.id })
        assertTrue(view.done.single().done)
    }

    // ---------------------------------------------------------------- pool order (B4-sync risk)

    @Test
    fun `the barcode name takes slot one even after 16 OCR lines - the 17-candidate risk`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        for (i in 1..16) {
            session.signal(ScanSignal.text("line $i", atMs = i.toLong()), nowMs = i.toLong())
        }
        assertEquals("16 OCR lines fill the pool on their own", 16, session.pendingTextQueries.size)

        session.signal(ScanSignal.barcode("3017620422003", 17), nowMs = 17)
        session.barcodeText("Nutella", "3017620422003", nowMs = 18)

        val queries = session.pendingTextQueries
        assertEquals(16, queries.size)
        assertEquals("the barcode's OFF name owns slot one", "Nutella", queries.first())
        assertEquals((1..15).map { "line $it" }, queries.drop(1))
        assertFalse("the 16th OCR line is the one dropped", queries.contains("line 16"))
    }

    @Test
    fun `OCR lines duplicating the barcode name or digits are not queries`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.barcode("3017620422003", 0), nowMs = 0)
        session.barcodeText("Milk", "3017620422003", nowMs = 1)
        session.signal(text("Milk"), nowMs = 2)
        session.signal(text("3017620422003"), nowMs = 3)
        session.signal(text("Bread"), nowMs = 4)

        assertEquals(listOf("Milk", "Bread"), session.pendingTextQueries)
    }

    @Test
    fun `an answer for another barcode is ignored`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.barcode("11111111", 0), nowMs = 0)
        session.barcodeText("Milk", "11111111", nowMs = 1)
        val hero = session.view.hero!!.id

        val ignored = session.barcodeText("Bread", "22222222", nowMs = 2)
        assertEquals("a late answer belongs to nobody", hero, ignored.hero!!.id)
        assertEquals("Milk", ignored.barcodeText)
        assertFalse(session.pendingTextQueries.contains("Bread"))
    }

    // ---------------------------------------------------------------- one tick, one pass

    @Test
    fun `commit keeps the ranked order but waits for the next product`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(text("Milk"), nowMs = 0)
        assertEquals("a", session.view.hero!!.id)

        val ticked = session.commit(
            items = items.map { if (it.id == "a") it.copy(done = true) else it },
            vectors = vectors,
            nowMs = 1,
        )
        assertEquals(ScanStatus.TICKED, ticked.status)
        assertNull(ticked.hero)
        assertEquals("Ticked. Point at the next product.", ticked.message)
        assertEquals(listOf("a"), ticked.done.map { it.id })
        assertEquals("the ranked order stays", listOf("b", "c"), ticked.rows.map { it.id })
        assertEquals("chips go dark on a tick", ScanChips(), ticked.chips)

        // A still camera never re-arms: neither another frame nor a re-read of the same line counts.
        val frame = session.signal(ScanSignal.image(byteArrayOf(1), atMs = 2), nowMs = 2)
        assertEquals(ScanStatus.TICKED, frame.status)
        val reread = session.signal(text("Milk"), nowMs = 3)
        assertEquals(ScanStatus.TICKED, reread.status)

        // A new word (a new product's label) re-arms the pass. That item's EMA starts from its
        // previous 0.0 score, so the honest sequence is 0.5 → 0.75 → 0.875: the camera keeps reading
        // the label and the hero appears on the third read (RANK.md's alpha is spec, not this card's).
        val firstRead = session.signal(text("Bread"), nowMs = 4)
        assertEquals(ScanStatus.NO_HERO, firstRead.status)
        assertNull(firstRead.hero)
        assertEquals(ScanStatus.NO_HERO, session.signal(text("Bread"), nowMs = 5).status)
        val warm = session.signal(text("Bread"), nowMs = 6)
        assertEquals(ScanStatus.HERO, warm.status)
        assertEquals("c", warm.hero!!.id)
    }

    @Test
    fun `a new barcode re-arms the pass, the same barcode does not`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.barcode("11111111", 0), nowMs = 0)
        session.barcodeText("Milk", "11111111", nowMs = 0)
        assertEquals(ScanStatus.HERO, session.view.status)
        session.commit(
            items = items.map { if (it.id == "a") it.copy(done = true) else it },
            vectors = vectors,
            nowMs = 1,
        )
        assertEquals(ScanStatus.TICKED, session.view.status)

        val same = session.signal(ScanSignal.barcode("11111111", 2), nowMs = 2)
        assertEquals("the product in front of the camera is the one just ticked", ScanStatus.TICKED, same.status)

        val newProduct = session.signal(ScanSignal.barcode("22222222", 3), nowMs = 3)
        assertEquals("a new product re-arms the hero", ScanStatus.NO_SIGNAL, newProduct.status)
        assertNull("the previous OFF name was dropped with its barcode", newProduct.barcodeText)
        assertTrue(session.pendingTextQueries.isEmpty())

        val answered = session.barcodeText("Bread", "22222222", nowMs = 4)
        assertEquals(ScanStatus.HERO, answered.status)
        assertEquals("c", answered.hero!!.id)
    }

    @Test
    fun `commit ticks immediately inside the 400 ms window, signals are gated`() {
        val session = session(ticker = RankTicker(minIntervalMs = 400, dims = 4))
        session.start(items, vectors, nowMs = 0)

        assertEquals("100 ms after start is not due", ScanStatus.NO_SIGNAL, session.signal(text("Milk"), 100).status)
        assertEquals("399 ms is still not due", ScanStatus.NO_SIGNAL, session.signal(text("Milk"), 399).status)
        assertEquals("400 ms is due", ScanStatus.HERO, session.signal(text("Milk"), 400).status)

        val ticked = session.commit(
            items = items.map { if (it.id == "a") it.copy(done = true) else it },
            vectors = vectors,
            nowMs = 401,
        )
        assertEquals("a tick is immediate even 1 ms after the last evaluation", ScanStatus.TICKED, ticked.status)
    }

    // ---------------------------------------------------------------- expiry

    @Test
    fun `stale OCR words stop driving the ranking`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        assertEquals(ScanStatus.HERO, session.signal(text("Milk"), nowMs = 0).status)

        // 3 s later the OCR word is stale and the failing image embedder supplies no frame query:
        // the honest answer is "no signal", not the old hero.
        val expired = session.signal(ScanSignal.image(byteArrayOf(1), atMs = 3_000), nowMs = 3_000)
        assertEquals(ScanStatus.NO_SIGNAL, expired.status)
        assertNull(expired.hero)
        assertFalse(expired.ranked)
        assertTrue("the IMAGE chip fired just now", expired.chips.image)
        assertTrue(session.pendingTextQueries.isEmpty())
    }

    @Test
    fun `start clears the previous pass and stop forgets everything`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.barcode("11111111", 0), nowMs = 0)
        session.barcodeText("Milk", "11111111", nowMs = 0)
        session.signal(text("Milk"), nowMs = 0)
        assertEquals(ScanStatus.HERO, session.view.status)

        val restarted = session.start(items, vectors, nowMs = 10)
        assertEquals(ScanStatus.NO_SIGNAL, restarted.status)
        assertNull(restarted.barcode)
        assertTrue(session.pendingTextQueries.isEmpty())
        assertFalse(restarted.chips.any)

        session.signal(text("Milk"), nowMs = 11)
        assertEquals(ScanStatus.HERO, session.view.status)

        val stopped = session.stop()
        assertEquals(ScanStatus.NO_SIGNAL, stopped.status)
        assertFalse(stopped.ranked)
        assertNull(stopped.hero)
        assertNull(stopped.barcode)
        assertEquals("camera closed: flatten order", listOf("a", "b", "c"), stopped.rows.map { it.id })
        assertFalse(stopped.chips.any)
        assertTrue(session.pendingTextQueries.isEmpty())
    }

    @Test
    fun `blank text and barcodes are ignored`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.text("   ", 0), nowMs = 0)
        session.signal(ScanSignal.barcode("   ", 1), nowMs = 1)
        assertNull(session.barcode)
        assertTrue(session.pendingTextQueries.isEmpty())
        assertEquals(ScanStatus.NO_SIGNAL, session.view.status)
    }

    // ---------------------------------------------------------------- sensor orientation

    @Test
    fun `a sideways frame is rotated upright before it is embedded`() {
        val rotator = RecordingRotator { jpeg, degrees -> jpeg + byteArrayOf(degrees.toByte()) }
        val embedder = embedder()
        val session = session(queryEmbedder = embedder, rotator = rotator)
        session.start(items, vectors, nowMs = 0)
        val jpeg = byteArrayOf(1, 2, 3)

        session.signal(ScanSignal.image(jpeg, atMs = 1, rotationDegrees = 90), nowMs = 1)
        assertEquals(listOf(90), rotator.calls)
        assertTrue("the original bytes go in", rotator.inputs.single().contentEquals(jpeg))
        assertTrue(
            "the embedder sees the upright bytes, not the sensor-sideways ones",
            embedder.imageRequests.single().contentEquals(jpeg + byteArrayOf(90)),
        )
    }

    @Test
    fun `an upright frame skips the bitmap rotation`() {
        val rotator = RecordingRotator()
        val embedder = embedder()
        val session = session(queryEmbedder = embedder, rotator = rotator)
        session.start(items, vectors, nowMs = 0)

        session.signal(ScanSignal.image(byteArrayOf(7), atMs = 1, rotationDegrees = 0), nowMs = 1)
        assertTrue("0 degrees means embed as-is", rotator.calls.isEmpty())
        assertTrue(embedder.imageRequests.single().contentEquals(byteArrayOf(7)))
    }

    @Test
    fun `a frame that cannot be rotated is not embedded at all`() {
        val rotator = RecordingRotator { _, _ -> null }
        val embedder = embedder(image = { axis(0) })
        val session = session(queryEmbedder = embedder, rotator = rotator)
        session.start(items, vectors, nowMs = 0)

        session.signal(ScanSignal.image(byteArrayOf(1), atMs = 1, rotationDegrees = 270), nowMs = 1)
        assertEquals(listOf(270), rotator.calls)
        assertTrue(embedder.imageRequests.isEmpty())
        assertEquals("text/barcode sources keep working", ScanStatus.NO_SIGNAL, session.view.status)
    }

    // ---------------------------------------------------------------- embedder call hygiene

    @Test
    fun `each text is embedded once per session, frames are not cached`() {
        val embedder = embedder(image = { axis(0) })
        val session = session(queryEmbedder = embedder)
        session.start(items, vectors, nowMs = 0)
        session.signal(text("Milk"), nowMs = 1)
        session.signal(text("Milk"), nowMs = 2)
        assertEquals(listOf("Milk"), embedder.textRequests)

        session.signal(ScanSignal.image(byteArrayOf(1), atMs = 3), nowMs = 3)
        session.signal(ScanSignal.image(byteArrayOf(2), atMs = 4), nowMs = 4)
        assertEquals("every frame is embedded (latest wins)", 2, embedder.imageRequests.size)

        session.start(items, vectors, nowMs = 5)
        session.signal(text("Milk"), nowMs = 6)
        assertEquals("a new session clears the query cache", 2, embedder.textRequests.size)
    }

    @Test
    fun `wrong dimension and non-finite query vectors are dropped`() {
        val wrongDim = object : QueryEmbedder {
            override val dims = 4
            override fun text(text: String): DoubleArray = DoubleArray(2) { 1.0 }
            override fun image(jpeg: ByteArray): DoubleArray? = null
        }
        val wrongDimSession = session(queryEmbedder = wrongDim)
        wrongDimSession.start(items, vectors, nowMs = 0)
        assertEquals(
            "a 2-d vector can never reach the 4-d ranker",
            ScanStatus.NO_SIGNAL,
            wrongDimSession.signal(text("Milk"), nowMs = 1).status,
        )

        val nonFinite = object : QueryEmbedder {
            override val dims = 4
            override fun text(text: String): DoubleArray = DoubleArray(4) { Double.NaN }
            override fun image(jpeg: ByteArray): DoubleArray? = null
        }
        val nanSession = session(queryEmbedder = nonFinite)
        nanSession.start(items, vectors, nowMs = 0)
        assertEquals(
            "a NaN query must not leak into a score",
            ScanStatus.NO_SIGNAL,
            nanSession.signal(text("Milk"), nowMs = 1).status,
        )
    }

    @Test
    fun `the barcode strip exposes trimmed digits and the OFF answer`() {
        val session = session()
        session.start(items, vectors, nowMs = 0)
        session.signal(ScanSignal.barcode("  3017620422003  ", 0), nowMs = 0)
        assertEquals("3017620422003", session.barcode)
        assertTrue(session.view.chips.barcode)

        val view = session.barcodeText("  Nutella  ", "3017620422003", nowMs = 1)
        assertEquals("Nutella", view.barcodeText)
    }
}
