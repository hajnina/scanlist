package dev.hajnina.scanlist.kotlin.rank

import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B3 Done-when: replay `shared/fixtures/golden.json` and match the expected top-3 for **every**
 * query, with no model and no device.
 *
 * Each query is one tick with `prev = null` (RANK.md §9 — `smoothed == raw`), exactly like
 * `shared/tools/make_golden.py --verify`: attach `itemVectors[id]` to the fixture's flattened items,
 * put the query vector in `queries.text` (already prefixed) or `queries.image` (unprefixed), rank,
 * and compare the first three non-done entries.
 *
 * The test collects every mismatch before failing so a regression shows how broad it is, not just the
 * first query.
 */
class GoldenRankTest {

    @Test
    fun `fixture has the shape the card describes`() {
        assertEquals("embeddinggemma-2-740m", Golden.model)
        assertEquals(256, Golden.dims)
        Golden.checkShape()
    }

    @Test
    fun `all 58 golden queries reproduce their expected top 3`() {
        val failures = ArrayList<String>()
        var checked = 0
        var scoreMismatches = 0
        for (query in Golden.queries) {
            val list = Golden.list(query.list)
            val items = Golden.rankItems(list)
            val queries = when (query.kind) {
                "text" -> RankQueries(text = listOf(query.vector))
                "image" -> RankQueries(image = listOf(query.vector))
                else -> error("unknown query kind ${query.kind}")
            }
            val result = rank(items = items, queries = queries, prev = null)
            val top = result.topEntries(3)
            val got = top.map { it.id }
            checked++

            if (got != query.expectedTop3) {
                failures += buildString {
                    append(query.id).append(" (").append(query.kind).append(", ").append(query.list).append(")")
                    if (query.text != null) append(" text=").append('"').append(query.text).append('"')
                    append(": got ").append(got).append(" want ").append(query.expectedTop3)
                }
                continue
            }
            if (result.topId != query.expectedTop3.first()) {
                failures += "${query.id}: topId ${result.topId} != expectedTop3[0] ${query.expectedTop3.first()}"
            }
            // The stored scores (`smoothed == raw` on a first tick) must match the oracle's numbers
            // exactly. The fixture's values are already q6-rounded, so a different dot-product
            // summation order (numpy vs this sequential float64 sum) is absorbed by q6: a 0-tolerance
            // comparison passes for all 174 compared scores (RANK.md §5's whole point).
            top.forEachIndexed { index, entry ->
                val want = query.expectedScores[index]
                val have = entry.smoothed
                if (have == null || abs(have - want) > 0.0) {
                    scoreMismatches++
                    failures += "${query.id}: score[$index] $have != $want"
                }
            }
        }
        assertEquals("queries replayed", 58, checked)
        assertTrue("score mismatches: $scoreMismatches", scoreMismatches == 0)
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun `every expectedTop3 id is an unchecked item of its list`() {
        for (query in Golden.queries) {
            val items = Golden.list(query.list).items.associateBy { it.id }
            for (id in query.expectedTop3) {
                val item = items[id] ?: error("${query.id}: ${id} is not in ${query.list}")
                assertTrue("${query.id}: ${id} is a done item", !item.done)
            }
        }
    }
}
