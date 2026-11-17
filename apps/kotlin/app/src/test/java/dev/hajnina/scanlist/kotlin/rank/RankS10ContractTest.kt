package dev.hajnina.scanlist.kotlin.rank

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RANK.md §6 as amended by card S10, exercised on the measured `shared/fixtures/golden.json` data:
 * the 12 text distractors, the `t20` near-tie, `cheese.jpg` (the image failure the accept-list guard
 * exists for) and `honey.jpg` (the one image query whose recorded OFF name confirms an item).
 *
 * These are replay tests, not unit tests of the gate maths: every vector/name comes from the fixture,
 * so a tuning change (`M`/`T`) that silently starts highlighting distractors fails here.
 */
class RankS10ContractTest {

    private fun rankOne(
        query: Golden.Query,
        barcodeName: String? = null,
        prev: RankState? = null,
        previous: RankResult? = null,
    ): RankResult {
        val queries = when (query.kind) {
            "text" -> RankQueries(text = listOf(query.vector))
            "image" -> RankQueries(image = listOf(query.vector))
            else -> error("unknown query kind ${query.kind}")
        }
        return rank(
            items = Golden.rankItems(Golden.list(query.list)),
            queries = queries,
            prev = prev,
            barcodeName = barcodeName,
            previous = previous,
        )
    }

    private fun entry(result: RankResult, id: String): RankEntry =
        result.entries.first { it.id == id }

    @Test
    fun `all 12 text distractors are suppressed by the margin gate`() {
        val distractors = Golden.queries.filter { it.kind == "text" && it.expect == "nomatch" }
        assertEquals("fixture has 12 text distractors", 12, distractors.size)
        val highlighted = ArrayList<String>()
        for (query in distractors) {
            val result = rankOne(query)
            if (result.topId != null) highlighted += "${query.id}->${result.topId}"
            // Their ranked order is still the oracle's top-3: only the highlight is gated.
            assertEquals(query.id, query.expectedTop3, result.topEntries(3).map { it.id })
        }
        assertTrue("distractors highlighted: $highlighted", highlighted.isEmpty())
    }

    @Test
    fun `31 text hits highlight except the t20 near-tie`() {
        val hits = Golden.queries.filter { it.kind == "text" && it.expect == "hit" }
        assertEquals(31, hits.size)
        val suppressed = hits.filter { rankOne(it).topId == null }.map { it.id }
        assertEquals("only the 0.039765-margin near-tie fails safe", listOf("t20"), suppressed)
        for (query in hits) {
            val result = rankOne(query)
            if (result.topId != null) {
                assertEquals("highlight is the oracle's top-1", query.expectedTop3.first(), result.topId)
            }
            assertEquals(query.expectedTop3, result.topEntries(3).map { it.id })
        }
    }

    @Test
    fun `cheese image passes the image gate but not the accept-list guard`() {
        val query = Golden.queries.first { it.id == "icheese" }
        val withoutName = rankOne(query)
        // Top-1 is Greek yoghurt (0.699416), Cheese is third (0.670091): the measured false highlight.
        assertEquals("Greek yoghurt", Golden.list(query.list).items.first { it.id == withoutName.topEntries(3)[0].id }.name)
        assertEquals(query.expectedTop3, withoutName.topEntries(3).map { it.id })
        assertNull("unconfirmed image winner has no hero", withoutName.topId)

        // The fixture's OFF name does not match Cheese (exact match after NFC + full casefold).
        val withOffName = rankOne(query, barcodeName = query.product)
        assertNull("'Fromage Blanc Nature' confirms nothing", withOffName.topId)
        assertEquals(query.expectedTop3, withOffName.topEntries(3).map { it.id })
    }

    @Test
    fun `honey image is promoted and highlighted only by its confirmed OFF name`() {
        val query = Golden.queries.first { it.id == "ihoney" }
        val honeyId = query.expectedTop3.first()
        assertEquals("Honey", Golden.list(query.list).items.first { it.id == honeyId }.name)

        val withoutName = rankOne(query)
        assertNull("0.752869 alone is not a hero", withoutName.topId)
        assertEquals(0.752869, entry(withoutName, honeyId).smoothed!!, 0.0)
        assertEquals(query.expectedTop3, withoutName.topEntries(3).map { it.id })

        val withOffName = rankOne(query, barcodeName = "Honey")
        assertEquals("Honey", withOffName.topId?.let { id ->
            Golden.list(query.list).items.first { it.id == id }.name
        })
        assertEquals("the confirmed name highlights the honey item", honeyId, withOffName.topId)
        assertEquals("0.752869 + the §3.1 boost", 0.902869, entry(withOffName, honeyId).smoothed!!, 0.0)
        assertEquals(honeyId, withOffName.topEntries(3).first().id)
    }

    @Test
    fun `image ticks without a confirmed OFF name never get a hero`() {
        val images = Golden.queries.filter { it.kind == "image" }
        assertEquals(15, images.size)
        for (query in images) {
            val result = rankOne(query)
            assertNull("${query.id}: unconfirmed image winner", result.topId)
            assertEquals("${query.id}: ranked order is unchanged", query.expectedTop3, result.topEntries(3).map { it.id })
        }

        // With the fixture's recorded OFF names only honey.jpg confirms an item (RANK.md §6.3).
        val highlighted = images.mapNotNull { query ->
            rankOne(query, barcodeName = query.product).topId?.let { "${query.id}->$it" }
        }
        assertEquals(listOf("ihoney->${images.first { it.id == "ihoney" }.expectedTop3.first()}"), highlighted)
    }

    @Test
    fun `a closed gate survives a second tick with state topId null`() {
        // §6.4: a closed gate stores topId = null, so the next tick starts from the sorted order.
        val query = Golden.queries.first { it.id == "icheese" }
        val tick1 = rankOne(query, barcodeName = query.product)
        assertNull(tick1.topId)
        assertNull(tick1.state.topId)
        val tick2 = rankOne(query, barcodeName = query.product, prev = tick1.state, previous = tick1)
        assertNull(tick2.topId)
        assertEquals(query.expectedTop3, tick2.topEntries(3).map { it.id })
    }
}
