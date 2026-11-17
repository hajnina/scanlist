package dev.hajnina.scanlist.kotlin.list

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** shared/spec/LIST.md §7: export produces the same shape, so import -> export -> import is equal. */
class ListRoundTripTest {

    @Test
    fun `every shared sample survives parse encode parse unchanged`() {
        Samples.requireAll().forEach { (name, text) ->
            val first = parse(text)
            val encoded = ListJson.encode(first)
            val second = parse(encoded)
            assertEquals("$name model round-trip", first, second)
            assertEquals("$name canonical form is stable", encoded, ListJson.encode(second))
        }
    }

    @Test
    fun `export keeps order, nesting, amounts, aliases and done flags`() {
        val list = parse(Samples.read("deep-nesting.json"))
        val reimported = parse(ListJson.encode(list))
        assertEquals(list, reimported)
        assertEquals(
            list.flatten().map { it.name to it.done },
            reimported.flatten().map { it.name to it.done },
        )
        assertEquals(
            list.sections[0].sections[0].sections[0].sections[0].items.map { it.name },
            reimported.sections[0].sections[0].sections[0].sections[0].items.map { it.name },
        )
        assertEquals(
            listOf("comino", "kmín"),
            reimported.sections[0].sections[0].sections[0].sections[0].items[0].aliases,
        )
        assertEquals(
            listOf("pimentón ahumado", "uzená paprika"),
            reimported.sections[0].sections[0].sections[0].sections[0].items[1].aliases,
        )
    }

    @Test
    fun `tick then export round-trips apart from done`() {
        val original = parse(Samples.read("van-weekly.json"))
        val bananas = original.flatten().first { it.name == "Bananas" }
        val ticked = original.withItemDone(bananas.id, true)

        val exported = ListJson.encode(ticked)
        val reimported = parse(exported)

        assertEquals(ticked, reimported)
        assertTrue(reimported.flatten().first { it.name == "Bananas" }.done)
        // Everything except the done flags is unchanged (LIST.md §7).
        assertEquals(
            original.flatten().map { it.copy(done = false) },
            reimported.flatten().map { it.copy(done = false) },
        )
    }

    @Test
    fun `numbers export as shortest round-trip decimals`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"S","items":[
                {"name":"A","amount":6},
                {"name":"B","amount":0.5},
                {"name":"C","amount":-2},
                {"name":"D","amount":"2 packs"},
                {"name":"E","amount":500,"unit":"g"}
            ]}]}""",
        )
        val json = ListJson.encode(list)
        assertTrue(json, json.contains("\"amount\": 6"))
        assertTrue(json, json.contains("\"amount\": 0.5"))
        assertTrue(json, json.contains("\"amount\": -2"))
        assertTrue(json, json.contains("\"amount\": \"2 packs\""))
        assertTrue(json, json.contains("\"amount\": 500"))
        assertTrue("no trailing .0 anywhere", !json.contains(".0,") && !json.contains(".0\n"))
        assertEquals(list, parse(json))
    }

    @Test
    fun `ticked items export done true and unticked items omit it`() {
        val list = parse(Samples.read("string-amounts.json"))
        val json = ListJson.encode(list)
        assertEquals(1, Regex("\"done\": true").findAll(json).count())
        assertEquals(0, Regex("\"done\": false").findAll(json).count())
        assertEquals(list.flatten().count { it.done }, Regex("\"done\": true").findAll(json).count())
    }

    @Test
    fun `unticking an imported ticked item round-trips as not done`() {
        val list = parse(Samples.read("string-amounts.json"))
        val ticked = list.flatten().single { it.done }
        val unticked = list.withItemDone(ticked.id, false)
        val json = ListJson.encode(unticked)
        assertEquals(0, Regex("\"done\": true").findAll(json).count())
        val reimported = parse(json)
        assertEquals(unticked, reimported)
        assertTrue(reimported.flatten().none { it.done })
        assertEquals(unticked.flatten().size, reimported.flatten().size)
    }

    @Test
    fun `unknown top-level fields are dropped but the rest still round-trips`() {
        val text = """{"title":"T","owner":"martin","sections":[{"name":"S","items":[{"name":"Milk","sku":"X"}]}]}"""
        val first = parse(text)
        val encoded = ListJson.encode(first)
        assertTrue(encoded, !encoded.contains("owner"))
        assertTrue(encoded, !encoded.contains("sku"))
        assertEquals(first, parse(encoded))
    }

    @Test
    fun `unknown version is parsed best-effort and kept`() {
        val list = parse("""{"title":"T","version":7,"sections":[]}""")
        assertEquals(7, list.version)
        assertTrue(ListJson.encode(list).contains("\"version\": 7"))
    }

    @Test
    fun `notes and aliases are stored verbatim while display and flatten normalise`() {
        val text = """{"title":"T","sections":[{"name":"S","items":[
            {"name":"Oat milk","note":"  the barista one  ","aliases":[" Leche ","   "]}]}]}"""
        val list = parse(text)
        val item = list.sections[0].items[0]
        // Storage keeps the authored bytes (round-trip fidelity)…
        assertEquals("  the barista one  ", item.note)
        assertEquals(listOf(" Leche "), item.aliases)
        // …while display and embedding text trim/normalise (LIST.md §4, FLATTEN.md §5).
        assertEquals("the barista one", item.displayNote())
        assertEquals(listOf("Leche"), list.flatten().single().aliases)
        val json = ListJson.encode(list)
        assertTrue(json, json.contains("\"note\": \"  the barista one  \""))
        assertEquals(list, parse(json))
    }

    @Test
    fun `compact and pretty encodings are the same document`() {
        val list = parse(Samples.read("aliases-es-cz.json"))
        assertEquals(
            parse(ListJson.encode(list, prettyPrint = false)),
            parse(ListJson.encode(list, prettyPrint = true)),
        )
    }

    private fun parse(text: String): ScanList =
        when (val result = ListJson.parse(text)) {
            is ListJson.ParseResult.Ok -> result.list
            is ListJson.ParseResult.Invalid -> error("parse failed: ${result.errors}")
        }
}
