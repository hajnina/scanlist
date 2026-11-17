package dev.hajnina.scanlist.kotlin.rank

import dev.hajnina.scanlist.kotlin.list.Amount
import dev.hajnina.scanlist.kotlin.list.FlatItem
import dev.hajnina.scanlist.kotlin.list.ListJson
import dev.hajnina.scanlist.kotlin.list.ListSection
import dev.hajnina.scanlist.kotlin.list.ScanList
import dev.hajnina.scanlist.kotlin.list.docText
import dev.hajnina.scanlist.kotlin.list.flatten
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Closes the loop between B2's Kotlin flattener and the fixture the ranker is measured on.
 *
 * `golden.json` was built from `shared/ref/scanlist_ref.py`'s `flatten()` + `doc_text()`; for every
 * list the test re-flattens the same nested JSON with B2's `ScanList.flatten()` and requires the
 * fixture's ids, order and every documented field — and in particular `docText()` — to match
 * byte for byte. Without this, a green rank replay could still mean "the ranker matches the fixture
 * while the app embeds different strings".
 *
 * The fifth fixture corpus (`photo-corpus`) is synthetic: `make_golden.py` merges the four samples
 * under one top-level section per sample and clears `done`. The test rebuilds exactly that object
 * from the four sample files, so all 5 lists / 88 items are covered.
 */
class GoldenFlattenTest {

    private val sampleIds = listOf("van-weekly", "string-amounts", "aliases-es-cz", "deep-nesting")

    @Test
    fun `all five fixture lists flatten to the same ids, fields and docText`() {
        for (id in sampleIds) {
            val fixture = Golden.list(id)
            assertFlattenMatches(fixture, parse(fixture.source).flatten())
        }

        val merged = ScanList(
            title = "Photo corpus — all four sample lists",
            version = 1,
            sections = sampleIds.map { id ->
                ListSection(name = id, sections = parse(Golden.list(id).source).sections.map { it.clearedDone() })
            },
        )
        val photoFixture = Golden.list("photo-corpus")
        assertEquals("photo corpus item count", photoFixture.itemCount, merged.flatten().size)
        assertFlattenMatches(photoFixture, merged.flatten())
    }

    @Test
    fun `every fixture item has a 256-d vector keyed by the flattened id`() {
        for (fixture in Golden.lists) {
            val flat = if (fixture.id == "photo-corpus") {
                val merged = ScanList(
                    title = fixture.title,
                    version = 1,
                    sections = sampleIds.map { id ->
                        ListSection(name = id, sections = parse(Golden.list(id).source).sections.map { it.clearedDone() })
                    },
                )
                merged.flatten()
            } else {
                parse(fixture.source).flatten()
            }
            assertEquals(fixture.itemCount, flat.size)
            for (item in flat) {
                val vector = fixture.itemVectors[item.id]
                assertNotNull("${fixture.id}: no vector for ${item.id}", vector)
                assertEquals("${fixture.id}/${item.id}: vector dims", 256, vector!!.size)
                assertEquals("${fixture.id}/${item.id}: docText", item.docText(), docTextOf(item, fixture))
            }
        }
    }

    private fun assertFlattenMatches(fixture: Golden.ListFixture, flat: List<FlatItem>) {
        assertEquals("${fixture.id}: item count", fixture.itemCount, flat.size)
        assertEquals("${fixture.id}: ids in flatten order", fixture.items.map { it.id }, flat.map { it.id })

        fixture.items.zip(flat).forEach { (want, have) ->
            val where = "${fixture.id}/${want.id}"
            assertEquals("$where: name", want.name, have.name)
            assertEquals("$where: amount", amountOf(want.amount), have.amount)
            assertEquals("$where: unit", want.unit, have.unit)
            assertEquals("$where: note", want.note, have.note)
            assertEquals("$where: aliases", want.aliases, have.aliases)
            assertEquals("$where: done", want.done, have.done)
            assertEquals("$where: path", want.path, have.path)
            assertEquals("$where: pathText", want.pathText, have.pathText)
            assertEquals("$where: index", want.index, have.index)
            assertEquals("$where: order", want.order, have.order)
            // The byte-exact part: this is the string the fixture's vector was embedded from.
            assertEquals("$where: docText", want.referenceDocText, have.docText())
        }
    }

    private fun docTextOf(item: FlatItem, fixture: Golden.ListFixture): String =
        fixture.items.first { it.id == item.id }.referenceDocText

    private fun amountOf(amount: Golden.Amount): Amount? = when (amount) {
        is Golden.Amount.Num -> Amount.Num(amount.value)
        is Golden.Amount.Text -> Amount.Text(amount.value)
        Golden.Amount.Missing -> null
    }

    private fun parse(source: String): ScanList = when (val parsed = ListJson.parse(Golden.sampleJson(source))) {
        is ListJson.ParseResult.Ok -> parsed.list
        is ListJson.ParseResult.Invalid -> {
            throw AssertionError("$source does not parse: ${parsed.errors}")
        }
    }

    private fun ListSection.clearedDone(): ListSection =
        copy(items = items.map { it.copy(done = false) }, sections = sections.map { it.clearedDone() })

    @Test
    fun `fixture docText construction is the spec one (not an accident of the test)`() {
        // A guard on the helper itself: the format is FLATTEN.md §4, "name; aliases; path" with
        // "; " and ", " / " > " separators — spelled out here once so a wrong helper cannot make the
        // comparison vacuous.
        val item = Golden.list("aliases-es-cz").items.first { it.name == "Milk" }
        assertTrue(item.aliases.isNotEmpty())
        assertEquals(
            "Milk; " + item.aliases.joinToString(", ") + "; " + item.path.joinToString(" > "),
            item.referenceDocText,
        )
    }
}
