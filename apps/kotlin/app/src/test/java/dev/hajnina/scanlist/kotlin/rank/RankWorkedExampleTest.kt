package dev.hajnina.scanlist.kotlin.rank

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The normative examples and edge rules of RANK.md, on 4-d toy vectors (`dims = 4`, as §10 does):
 * q6 rounding, max fusion, EMA α = 0.5, the 0.02 hysteresis (exactly 0.02 must NOT switch), output
 * order with the done group, the barcode boost, and every §8 degraded state.
 */
class RankWorkedExampleTest {

    // RANK.md §10: three items in flatten order, every other rule applies unchanged.
    private val milk = RankItem("a", "Milk", vec = v(1.0, 0.0, 0.0, 0.0), order = 0)
    private val oatMilk = RankItem("b", "Oat milk", vec = v(0.6, 0.8, 0.0, 0.0), order = 1)
    private val bread = RankItem("c", "Bread", vec = v(0.0, 0.0, 1.0, 0.0), order = 2)
    private val items = listOf(milk, oatMilk, bread)

    private val q1 = v(1.0, 0.0, 0.0, 0.0)
    private val q2 = v(0.8, 0.6, 0.0, 0.0)

    @Test
    fun `worked example ticks 1 to 5 behave exactly as the spec says`() {
        // Tick 1: no previous state → smoothed == raw.
        val tick1 = rank(items, RankQueries(text = listOf(q1)), prev = null, dims = 4)
        assertEquals(listOf("a", "b", "c"), tick1.topEntries(3).map { it.id })
        assertEquals(1.0, tick1.state.smoothed["a"]!!, 0.0)
        assertEquals(0.6, tick1.state.smoothed["b"]!!, 0.0)
        assertEquals(0.0, tick1.state.smoothed["c"]!!, 0.0)
        assertEquals("a", tick1.topId)

        // Tick 2: EMA → a 0.9, b 0.78, c 0.0; a still the top.
        val tick2 = rank(items, RankQueries(text = listOf(q2)), tick1.state, previous = tick1, dims = 4)
        assertEquals(0.9, tick2.state.smoothed["a"]!!, 0.0)
        assertEquals(0.78, tick2.state.smoothed["b"]!!, 0.0)
        assertEquals("a", tick2.topId)

        // Tick 3: a 0.825... no — a (0.8+0.9)/2 = 0.85, b (0.96+0.78)/2 = 0.87. b leads by exactly
        // 0.02, which is NOT more than 0.02 → the top STAYS a, and a is still rendered first.
        val tick3 = rank(items, RankQueries(text = listOf(q2)), tick2.state, previous = tick2, dims = 4)
        assertEquals(0.85, tick3.state.smoothed["a"]!!, 0.0)
        assertEquals(0.87, tick3.state.smoothed["b"]!!, 0.0)
        assertEquals("a", tick3.topId)
        assertEquals(listOf("a", "b", "c"), tick3.entries.map { it.id })

        // Tick 4: a 0.825, b 0.915 → ahead by 0.09 → b becomes the top and is rendered first.
        val tick4 = rank(items, RankQueries(text = listOf(q2)), tick3.state, previous = tick3, dims = 4)
        assertEquals(0.825, tick4.state.smoothed["a"]!!, 0.0)
        assertEquals(0.915, tick4.state.smoothed["b"]!!, 0.0)
        assertEquals("b", tick4.topId)
        assertEquals(listOf("b", "a", "c"), tick4.entries.map { it.id })

        // Tick 5: tick `a` (done) — it leaves the candidates and the state immediately; the done group
        // is appended with null scores, and b is the top with no hysteresis delay.
        val withDone = listOf(milk.copy(done = true), oatMilk, bread)
        val tick5 = rank(withDone, RankQueries(text = listOf(q2)), tick4.state, previous = tick4, dims = 4)
        assertEquals(listOf("b", "c", "a"), tick5.entries.map { it.id })
        assertEquals("b", tick5.topId)
        assertEquals(setOf("b", "c"), tick5.state.smoothed.keys)
        val doneEntry = tick5.entries.last()
        assertTrue(doneEntry.done)
        assertNull(doneEntry.raw)
        assertNull(doneEntry.smoothed)

        // Untick `a`: prev = None → smoothed == its next raw (no memory of 0.825).
        val tick6 = rank(listOf(milk, oatMilk, bread), RankQueries(text = listOf(q2)), tick5.state, previous = tick5, dims = 4)
        assertEquals(0.8, tick6.state.smoothed["a"]!!, 0.0)
        assertEquals("b", tick6.topId)
    }

    @Test
    fun `barcode boost adds 0_15 to raw before the EMA and never clips`() {
        val q = v(0.6, 0.8, 0.0, 0.0)
        val milkItem = RankItem("a", "Milk", vec = v(1.0, 0.0, 0.0, 0.0), order = 0)
        val oatItem = RankItem("b", "Oat milk", vec = v(0.6, 0.8, 0.0, 0.0), order = 1)
        val result = rank(
            listOf(milkItem, oatItem),
            RankQueries(text = listOf(q)),
            prev = null,
            barcodeName = "  milk ",
            dims = 4,
        )
        val byId = result.entries.associateBy { it.id }
        assertEquals("milk matched: 0.6 + 0.15", 0.75, byId["a"]!!.raw!!, 0.0)
        assertEquals("oat milk does not match 'milk'", 1.0, byId["b"]!!.raw!!, 0.0)
        assertEquals(listOf("b", "a"), result.entries.map { it.id })

        // An alias matches too, and the boost alone never ranks without a query (has_signal).
        val alias = rank(
            listOf(RankItem("x", "Leche entera", listOf("leche"), vec = v(1.0, 0.0, 0.0, 0.0))),
            RankQueries(text = listOf(q)),
            prev = null,
            barcodeName = "LECHE",
            dims = 4,
        )
        assertEquals(0.75, alias.entries.first().raw!!, 0.0)

        val noSignal = rank(listOf(milkItem), RankQueries(), prev = null, barcodeName = "milk", dims = 4)
        assertFalse(noSignal.ranked)
        assertNull(noSignal.topId)
    }

    @Test
    fun `q6 rounds half away from zero at 6 dp and normalises negative zero`() {
        assertEquals(1.0, q6(0.9999996), 0.0)
        assertEquals(0.000001, q6(0.0000005), 0.0)
        assertEquals(-0.000001, q6(-0.0000005), 0.0)
        assertEquals(0.123457, q6(0.1234565), 0.0)
        assertEquals(0.0, q6(-0.0), 0.0)
        assertTrue("q6(-0.0) is +0.0", 1.0 / q6(-0.0) > 0)
        assertEquals(0.0, q6(Double.NaN), 0.0)
        assertEquals(0.0, q6(Double.POSITIVE_INFINITY), 0.0)
    }

    @Test
    fun `hysteresis is strictly greater than 0_02 and ties go to flatten order`() {
        assertEquals(
            "exactly 0.02 keeps the current top",
            "cur",
            decideTop(listOf(RankCandidate("best", 1, 0.9, 0.87), RankCandidate("cur", 0, 0.8, 0.85)), "cur")!!.id,
        )
        assertEquals(
            "0.021 switches",
            "best",
            decideTop(listOf(RankCandidate("best", 1, 0.9, 0.871), RankCandidate("cur", 0, 0.8, 0.85)), "cur")!!.id,
        )
        assertEquals(
            "a vanished current top hands over immediately",
            "best",
            decideTop(listOf(RankCandidate("best", 1, 0.9, 0.5)), "cur")!!.id,
        )
        assertNull(decideTop(emptyList(), "cur"))

        // Equal smoothed scores: order decides, and the top is the lower order.
        val tie = rank(
            listOf(
                RankItem("second", "Second", vec = v(0.6, -0.8, 0.0, 0.0), order = 1),
                RankItem("first", "First", vec = v(0.6, 0.8, 0.0, 0.0), order = 0),
            ),
            RankQueries(text = listOf(v(1.0, 0.0, 0.0, 0.0))),
            prev = null,
            dims = 4,
        )
        val byId = tie.entries.associateBy { it.id }
        assertEquals(0.6, byId["first"]!!.smoothed!!, 0.0)
        assertEquals(0.6, byId["second"]!!.smoothed!!, 0.0)
        assertEquals("first", tie.topId)
        assertEquals(listOf("first", "second"), tie.entries.map { it.id })
    }

    @Test
    fun `fusion is max of max, never a mean`() {
        val item = RankItem("a", "A", vec = v(1.0, 0.0, 0.0, 0.0))
        val result = rank(
            listOf(item),
            RankQueries(text = listOf(v(0.5, 0.5, 0.5, 0.5), v(0.0, 0.0, 0.0, 1.0)), image = listOf(v(0.0, 0.0, 1.0, 0.0))),
            prev = null,
            dims = 4,
        )
        // text cosines: 0.5 and 0.0 → 0.5; image: 0.0 → max(0.5, 0.0) = 0.5.
        assertEquals(0.5, result.entries.first().raw!!, 0.0)
    }

    @Test
    fun `degraded states follow section 8`() {
        // No signal: unranked, flatten order, done flags kept, state cleared.
        val noSignal = rank(items, RankQueries(), prev = RankState(mapOf("a" to 0.9), "a"), dims = 4)
        assertFalse(noSignal.ranked)
        assertNull(noSignal.topId)
        assertEquals(listOf("a", "b", "c"), noSignal.entries.map { it.id })
        assertTrue(noSignal.entries.all { it.raw == null && it.smoothed == null })
        assertEquals(RankState.EMPTY, noSignal.state)

        // A missing item vector: do not evaluate; the first tick falls back to flatten order.
        val missing = rank(
            listOf(milk.copy(vec = null), oatMilk, bread),
            RankQueries(text = listOf(q1)),
            prev = null,
            dims = 4,
        )
        assertFalse("missing vector ⇒ no evaluation", missing.ranked)
        assertEquals(listOf("a", "b", "c"), missing.entries.map { it.id })
        assertEquals(emptyList<RankEntry>(), missing.entries.filter { it.raw != null })

        // …and later ticks return exactly the previous output with the caller's state.
        val previous = rank(items, RankQueries(text = listOf(q1)), prev = null, dims = 4)
        val carried = rank(
            listOf(milk.copy(vec = null), oatMilk, bread),
            RankQueries(text = listOf(q2)),
            prev = previous.state,
            previous = previous,
            dims = 4,
        )
        assertEquals(previous.entries, carried.entries)
        assertEquals(previous.state.smoothed, carried.state.smoothed)
        assertEquals(previous.topId, carried.state.topId)

        // Wrong dims is treated exactly like a missing vector (§8).
        val wrongDims = rank(
            listOf(milk.copy(vec = DoubleArray(5) { 0.0 }), oatMilk),
            RankQueries(text = listOf(q1)),
            prev = null,
            dims = 4,
        )
        assertFalse(wrongDims.ranked)

        // All items checked: ranked stays true, nothing highlighted, done group only.
        val allDone = rank(items.map { it.copy(done = true) }, RankQueries(text = listOf(q1)), prev = null, dims = 4)
        assertTrue(allDone.ranked)
        assertNull(allDone.topId)
        assertEquals(listOf("a", "b", "c"), allDone.entries.map { it.id })
        assertTrue(allDone.entries.all { it.done })
        assertEquals(RankState.EMPTY, allDone.state)

        // Zero items.
        val none = rank(emptyList(), RankQueries(text = listOf(q1)), prev = null, dims = 4)
        assertTrue(none.ranked)
        assertNull(none.topId)
        assertEquals(emptyList<RankEntry>(), none.entries)

        // An all-zero query scores 0.0 with everything (ties → flatten order), never NaN.
        val zeroQuery = rank(items, RankQueries(text = listOf(DoubleArray(4))), prev = null, dims = 4)
        assertEquals(listOf("a", "b", "c"), zeroQuery.entries.map { it.id })
        assertEquals(0.0, zeroQuery.entries.first().raw!!, 0.0)

        // A NaN query is dropped; with no other query that is "no signal".
        val nanOnly = rank(items, RankQueries(text = listOf(DoubleArray(4) { Double.NaN })), prev = null, dims = 4)
        assertFalse(nanOnly.ranked)

        // …and it cannot pollute a tick that has a valid query next to it.
        val withNan = rank(
            items,
            RankQueries(text = listOf(DoubleArray(4) { Double.NaN }, q1)),
            prev = null,
            dims = 4,
        )
        assertEquals(1.0, withNan.entries.first().raw!!, 0.0)
        assertTrue(withNan.entries.all { it.raw!!.isFinite() })

        // Wrong-dim query vectors are dropped the same way.
        val wrongDimQuery = rank(items, RankQueries(text = listOf(DoubleArray(5))), prev = null, dims = 4)
        assertFalse(wrongDimQuery.ranked)
    }

    @Test
    fun `truncation happens before normalisation`() {
        val native = DoubleArray(6) { 0.0 }
        native[0] = 3.0
        native[1] = 4.0
        native[4] = 100.0 // beyond the active dims: dropped before the norm is taken
        val unit = truncateAndNormalize(native, dims = 4)
        assertEquals(4, unit.size)
        assertEquals(0.6, unit[0], 1e-15)
        assertEquals(0.8, unit[1], 1e-15)
        assertEquals(0.0, unit[2], 0.0)
        assertEquals(1.0, kotlin.math.sqrt(unit.sumOf { it * it }), 1e-15)
        assertEquals(0.0, truncateAndNormalize(DoubleArray(4), dims = 4).sumOf { it * it }, 0.0)
    }

    private fun v(vararg values: Double): DoubleArray = values
}
