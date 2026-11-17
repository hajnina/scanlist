package dev.hajnina.scanlist.kotlin.rank

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RANK.md §7 cadence/lifecycle: the ticker evaluates at most once per 400 ms, immediate ticks
 * (tick/untick, list change, scan start/stop) reset the clock, and stopping a scan clears the query
 * set, the state and the highlight. Time is a parameter, so nothing here sleeps.
 */
class RankTickerTest {

    private val items = listOf(
        RankItem("a", "Milk", vec = v(1.0, 0.0, 0.0, 0.0), order = 0),
        RankItem("b", "Oat milk", vec = v(0.6, 0.8, 0.0, 0.0), order = 1),
    )

    @Test
    fun `ticks are gated by the 400 ms window and immediate ticks reset it`() {
        val ticker = RankTicker(minIntervalMs = 400, dims = 4)
        ticker.submit(text = listOf(v(1.0, 0.0, 0.0, 0.0)))

        val first = ticker.tick(items, atMs = 0)
        assertNotNull(first)
        assertEquals("a", first!!.topId)

        assertNull("399 ms after the last evaluation nothing happens", ticker.tick(items, atMs = 399))
        assertNotNull("400 ms is due", ticker.tick(items, atMs = 400))

        // An item was ticked: immediate, and it resets the clock.
        val now = ticker.tickNow(items, atMs = 401)
        assertEquals("a", now.topId)
        assertNull(ticker.tick(items, atMs = 700))
        assertNotNull(ticker.tick(items, atMs = 801))
    }

    @Test
    fun `submit replaces the pending query set - the latest frame wins`() {
        // A fresh session per frame: with alpha 0.5 a second tick is deliberately smoothed, which is
        // the next test's business.
        val onB = RankTicker(minIntervalMs = 0, dims = 4).also { it.submit(text = listOf(v(0.0, 1.0, 0.0, 0.0))) }
        assertEquals("b", onB.tick(items, atMs = 1)!!.topId)

        val onA = RankTicker(minIntervalMs = 0, dims = 4).also { it.submit(text = listOf(v(1.0, 0.0, 0.0, 0.0))) }
        assertEquals("a", onA.tick(items, atMs = 2)!!.topId)
        // Replacing the set inside one session replaces the pending queries (no queue).
        onA.submit(text = listOf(v(0.0, 1.0, 0.0, 0.0)))
        assertEquals(1, onA.queries.text.size)
        assertEquals(0.0, onA.queries.text.single()[0], 0.0)
        // A null argument keeps that source unchanged.
        onA.submit(image = null)
        assertEquals(1, onA.queries.text.size)
    }

    @Test
    fun `listChanged clears the EMA state and the highlight`() {
        val ticker = RankTicker(minIntervalMs = 0, dims = 4)
        ticker.submit(text = listOf(v(1.0, 0.0, 0.0, 0.0)))
        ticker.tick(items, atMs = 0)
        ticker.submit(text = listOf(v(0.0, 1.0, 0.0, 0.0)))
        ticker.tick(items, atMs = 1)
        assertTrue(ticker.state.smoothed["a"]!! > 0.0)

        val changed = ticker.listChanged(items, atMs = 2)
        assertEquals("state cleared ⇒ smoothed == raw", 0.0, changed.state.smoothed["a"]!!, 0.0)
        assertEquals(0.8, changed.state.smoothed["b"]!!, 0.0)
        assertEquals("b", changed.topId)
    }

    @Test
    fun `scanStopped returns the unranked flatten order and forgets everything`() {
        val ticker = RankTicker(minIntervalMs = 0, dims = 4)
        ticker.submit(text = listOf(v(1.0, 0.0, 0.0, 0.0)))
        ticker.tick(items, atMs = 0)

        val stopped = ticker.scanStopped(listOf(items[0], items[1].copy(done = true)))
        assertFalse(stopped.ranked)
        assertNull(stopped.topId)
        assertEquals(listOf("a", "b"), stopped.entries.map { it.id })
        assertTrue(stopped.entries.last().done)
        assertEquals(RankState.EMPTY, stopped.state)
        assertEquals(RankQueries(), ticker.queries)
        assertNull("no queries ⇒ the next tick is unranked", ticker.tick(items, atMs = 1)!!.topId)
    }

    @Test
    fun `scanStarted starts from an empty state`() {
        val ticker = RankTicker(minIntervalMs = 400, dims = 4)
        ticker.submit(text = listOf(v(0.0, 1.0, 0.0, 0.0)))
        ticker.tick(items, atMs = 0)
        ticker.submit(text = listOf(v(1.0, 0.0, 0.0, 0.0)))
        val started = ticker.scanStarted(items, atMs = 10)
        assertEquals(1.0, started.state.smoothed["a"]!!, 0.0)
        assertEquals(0.6, started.state.smoothed["b"]!!, 0.0)
        assertEquals("a", started.topId)
    }

    private fun v(vararg values: Double): DoubleArray = values
}
