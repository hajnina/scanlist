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

        // Tick 3: a (0.8+0.9)/2 = 0.85, b (0.96+0.78)/2 = 0.87. b leads by exactly 0.02, which is
        // NOT more than 0.02 → hysteresis keeps a as the hero candidate, but §6.2 needs a 0.05 margin
        // and 0.02 < 0.05 → NO hero this tick. Entries are the plain ranked order b, a, c.
        val tick3 = rank(items, RankQueries(text = listOf(q2)), tick2.state, previous = tick2, dims = 4)
        assertEquals(0.85, tick3.state.smoothed["a"]!!, 0.0)
        assertEquals(0.87, tick3.state.smoothed["b"]!!, 0.0)
        assertNull("closed §6.2 gate hides the hero", tick3.topId)
        assertNull("state.topId mirrors the highlight", tick3.state.topId)
        assertEquals(listOf("b", "a", "c"), tick3.entries.map { it.id })

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
    fun `hysteresis is strictly greater than 0_02 and the text gate closes inside the band`() {
        // §6.1 would keep `cur` (the challenger is 0.02 ahead, not > 0.02), but §6.2 closes the text
        // gate because the margin (0.02) is below M_text = 0.05: no hero rather than a flicker.
        assertNull(
            decideTop(
                listOf(
                    RankCandidate("best", 1, 0.87, 0.87),
                    RankCandidate("cur", 0, 0.85, 0.85),
                ),
                "cur",
            ),
        )
        // A challenger ahead by > 0.02 and a margin >= 0.05 switches.
        assertEquals(
            "0.051 switches and clears the text gate",
            "best",
            decideTop(
                listOf(
                    RankCandidate("best", 1, 0.871, 0.871),
                    RankCandidate("cur", 0, 0.82, 0.82),
                ),
                "cur",
            )!!.id,
        )
        assertEquals(
            "a vanished current top hands over immediately",
            "best",
            decideTop(listOf(RankCandidate("best", 1, 0.9, 0.9)), "cur")!!.id,
        )
        assertNull(decideTop(emptyList(), "cur"))

        // Equal smoothed scores: order decides, but the 0.0 margin fails §6.2 → no hero.
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
        assertNull("flat list: decisive margin is 0.0", tie.topId)
        assertEquals(listOf("first", "second"), tie.entries.map { it.id })
    }

    @Test
    fun `per-source gate boundaries are inclusive and q6-rounded`() {
        fun text(id: String, score: Double) = RankCandidate(id, 0, score, score, RankSource.TEXT)
        fun image(id: String, score: Double) = RankCandidate(id, 0, score, score, RankSource.IMAGE)

        // Text margin: exactly 0.05 clears, anything below does not (inclusive, q6).
        assertEquals(
            "exactly 0.05 clears",
            "a",
            decideTop(listOf(text("a", 0.85), text("b", 0.80)), null)!!.id,
        )
        assertNull(decideTop(listOf(text("a", 0.8500004), text("b", 0.800001)), null))
        assertNull(decideTop(listOf(text("a", 0.8499), text("b", 0.80)), null))
        // q6 rounds the 0.0500004 margin to 0.05.
        assertEquals("q6(0.85 - 0.7999996) == 0.05", "a", decideTop(listOf(text("a", 0.85), text("b", 0.7999996)), null)!!.id)

        // Text floor: exactly 0.79 clears; below it does not (single candidate → margin vacuous).
        assertEquals("0.79 clears", "a", decideTop(listOf(text("a", RANK_NO_MATCH_TEXT)), null)!!.id)
        assertNull(decideTop(listOf(text("a", 0.789999)), null))

        // Image gate: M_image 0.005 / T_image 0.68, plus the §6.3 accept-list guard.
        assertEquals(
            "exactly 0.005 clears for a confirmed image hero",
            "a",
            decideTop(listOf(image("a", 0.68), image("b", 0.675)), null, setOf("a"))!!.id,
        )
        assertNull(decideTop(listOf(image("a", 0.680001), image("b", 0.675002)), null, setOf("a")))
        assertNull(decideTop(listOf(image("a", 0.679999), image("b", 0.60)), null, setOf("a")))
        assertNull(decideTop(listOf(image("a", 0.9), image("b", 0.60)), null, emptySet()))
        assertEquals(
            "a single confirmed image candidate has a vacuous margin, not a closed gate",
            "a",
            decideTop(listOf(image("a", 0.68)), null, setOf("a"))!!.id,
        )
    }

    @Test
    fun `image path applies hysteresis and the accept list together`() {
        // RANK.md §10's image tick: M_image = 0.005 < the 0.02 hysteresis band, so both rules apply.
        val x = RankItem("x", "Milk", vec = v(0.700, 0.0, 0.0, 0.0), order = 0)
        val y = RankItem("y", "Oats", aliases = listOf("milk"), vec = v(0.705, 0.0, 0.0, 0.0), order = 1)
        val prev = RankState(mapOf("x" to 0.850, "y" to 0.855), "x")
        val confirmed = rank(
            listOf(x, y),
            RankQueries(image = listOf(v(1.0, 0.0, 0.0, 0.0))),
            prev = prev,
            barcodeName = "milk",
            dims = 4,
        )
        assertEquals(0.850, confirmed.state.smoothed["x"]!!, 0.0)
        assertEquals(0.855, confirmed.state.smoothed["y"]!!, 0.0)
        assertEquals("y leads by exactly M_image, but hysteresis keeps x", "x", confirmed.topId)
        assertEquals(listOf("x", "y"), confirmed.entries.map { it.id })

        // Same vectors and no OFF name: neither item is confirmed, so §6.3 hides the hero (§10).
        val unconfirmed = rank(
            listOf(x, y),
            RankQueries(image = listOf(v(1.0, 0.0, 0.0, 0.0))),
            prev = null,
            barcodeName = null,
            dims = 4,
        )
        assertEquals(0.700, unconfirmed.state.smoothed["x"]!!, 0.0)
        assertEquals(0.705, unconfirmed.state.smoothed["y"]!!, 0.0)
        assertNull("unconfirmed image winner has no hero", unconfirmed.topId)
        assertEquals("entries stay the full ranked order", listOf("y", "x"), unconfirmed.entries.map { it.id })
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
