package dev.hajnina.scanlist.kotlin.list

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** shared/spec/LIST.md §1-§6: every shared sample parses, every invalid example is rejected. */
class ListJsonParseTest {

    @Test
    fun `every shared sample parses`() {
        val expected = mapOf(
            "aliases-es-cz.json" to 13,
            "deep-nesting.json" to 10,
            "string-amounts.json" to 11,
            "van-weekly.json" to 10,
        )
        val samples = Samples.requireAll()
        assertEquals(expected.keys.toList(), samples.map { it.first })

        var total = 0
        samples.forEach { (name, text) ->
            val result = ListJson.parse(text)
            val list = (result as? ListJson.ParseResult.Ok)?.list
                ?: error("$name failed: ${(result as ListJson.ParseResult.Invalid).errors}")
            val count = list.flatten().size
            assertEquals("$name item count", expected.getValue(name), count)
            total += count
            assertTrue("$name title", list.title.isNotBlank())
            assertEquals("$name version", 1, list.version)
        }
        assertEquals("44 items across the 4 samples", 44, total)
    }

    @Test
    fun `van weekly keeps section order, nesting and the amount union`() {
        val list = read("van-weekly.json")
        assertEquals("Van weekly shop", list.title)
        assertEquals(listOf("Fresh", "Pantry", "Household"), list.sections.map { it.name })
        assertEquals(listOf("Fruit & veg", "Dairy"), list.sections[0].sections.map { it.name })

        val fruit = list.sections[0].sections[0]
        assertEquals(Amount.Num(6.0), fruit.items[0].amount)
        assertEquals("6", fruit.items[0].displayText())
        assertEquals(Amount.Num(1.0), fruit.items[1].amount)
        assertEquals("1 kg", fruit.items[1].displayText())
        assertEquals(listOf("tomates"), fruit.items[1].aliases)

        val pasta = list.sections[1].items[0]
        assertEquals("Pasta", pasta.name)
        assertEquals(Amount.Text("2 packs"), pasta.amount)
        assertEquals("2 packs", pasta.displayText())

        val coffee = list.sections[1].items[2]
        assertEquals(Amount.Num(500.0), coffee.amount)
        assertEquals("500 g", coffee.displayText())
    }

    @Test
    fun `string amounts are never coerced to numbers`() {
        val list = read("string-amounts.json")
        val honey = list.sections[0].items[4]
        assertEquals(Amount.Text("1/2"), honey.amount)
        assertEquals("1/2 jar", honey.displayText())
        val milk = list.sections[1].items[0]
        assertEquals(Amount.Num(2.0), milk.amount)
        assertEquals("2 l", milk.displayText())
        val ice = list.sections[1].items[4]
        assertEquals(Amount.Num(0.5), ice.amount)
        assertTrue(ice.done)
        assertEquals("0.5 l", ice.displayText())
    }

    @Test
    fun `deep nesting keeps explicit ids and done flags`() {
        val list = read("deep-nesting.json")
        val cumin = list.sections[0].sections[0].sections[0].sections[0].items[0]
        assertEquals("spice-cumin", cumin.id)
        assertEquals(listOf("comino", "kmín"), cumin.aliases)

        val done = list.flatten().filter { it.done }.map { it.name }
        assertEquals(listOf("Bay leaves", "Red lentils"), done)
    }

    @Test
    fun `minimal valid list and empty sections`() {
        val ok = ListJson.parse("""{"title":"Corner shop","sections":[{"name":"Tonight","items":[{"name":"Bread"}]}]}""")
        val list = (ok as ListJson.ParseResult.Ok).list
        assertEquals(1, list.version)
        assertEquals("Bread", list.flatten().single().name)

        val empty = ListJson.parse("""{"title":"Nothing to buy","sections":[]}""")
        assertTrue(empty is ListJson.ParseResult.Ok)
        assertEquals(0, (empty as ListJson.ParseResult.Ok).list.flatten().size)
    }

    @Test
    fun `unknown fields are ignored, never fatal`() {
        val json = """
            {"title":"T","colour":"red","version":1,
             "sections":[{"name":"S","order":3,
               "items":[{"name":"Milk","brand":"x","meta":{"a":1},"amount":2}]}]}
        """.trimIndent()
        val result = ListJson.parse(json)
        val list = (result as? ListJson.ParseResult.Ok)?.list ?: error("should parse")
        assertEquals("Milk", list.sections[0].items[0].name)
        assertEquals(Amount.Num(2.0), list.sections[0].items[0].amount)
    }

    @Test
    fun `empty amount string and blank unit are treated as absent`() {
        val list = readJson("""{"title":"T","sections":[{"name":"S","items":[
            {"name":"Milk","amount":"   ","unit":"  "},
            {"name":"Bread","unit":"loaf"}
        ]}]}""")
        val milk = list.sections[0].items[0]
        assertEquals(null, milk.amount)
        assertEquals(null, milk.unit)
        assertEquals("", milk.displayText())
        // unit without amount renders as nothing (LIST.md §4 example).
        assertEquals("", list.sections[0].items[1].displayText())
    }

    @Test
    fun `invalid documents report JSON pointers`() {
        val cases = mapOf(
            """{"sections":[]}""" to "/title: required",
            """{"title":"   ","sections":[]}""" to "/title: must not be empty",
            """{"title":"T","sections":{}}""" to "/sections: expected an array of sections",
            """{"title":"T","version":"1","sections":[]}""" to "/version: expected an integer",
            """{"title":"T","sections":[{"name":3}]}""" to "/sections/0/name: expected a string",
            """{"title":"T","sections":[{"items":[]}]}""" to "/sections/0/name: required",
            """{"title":"T","sections":[{"name":"S","items":[{"amount":2}]}]}""" to
                "/sections/0/items/0/name: required",
            """{"title":"T","sections":[{"name":"S","items":[{"name":"M","amount":null}]}]}""" to
                "/sections/0/items/0/amount: expected a number or a string, not null",
            """{"title":"T","sections":[{"name":"S","items":[{"name":"M","aliases":"milk"}]}]}""" to
                "/sections/0/items/0/aliases: expected an array of strings",
            """{"title":"T","sections":[{"name":"S","items":[{"name":"M","done":"yes"}]}]}""" to
                "/sections/0/items/0/done: expected a boolean",
            """{"title":"T","sections":[{"name":"S","items":[{"name":"M","amount":true}]}]}""" to
                "/sections/0/items/0/amount: expected a number or a string",
            """{"title":"T","sections":[{"name":"S","items":{}}]}""" to
                "/sections/0/items: expected an array of items",
        )
        cases.forEach { (json, expected) ->
            val result = ListJson.parse(json)
            val errors = (result as? ListJson.ParseResult.Invalid)?.errors
                ?: error("should have been invalid: $json")
            assertTrue("expected <$expected> in $errors for $json", errors.any { it.startsWith(expected) })
        }
    }

    @Test
    fun `non-object roots and non-JSON text are errors, not crashes`() {
        listOf("", " ", "[]", "\"list\"", "{", "not json", "null").forEach { text ->
            val result = ListJson.parse(text)
            assertTrue("should be invalid: <$text>", result is ListJson.ParseResult.Invalid)
        }
        val empty = ListJson.errorsOf(ListJson.parse(""))
        assertTrue(empty.single().startsWith("/: not valid JSON"))
    }

    private fun read(name: String): ScanList = readJson(Samples.read(name))

    private fun readJson(text: String): ScanList =
        when (val result = ListJson.parse(text)) {
            is ListJson.ParseResult.Ok -> result.list
            is ListJson.ParseResult.Invalid -> error("parse failed: ${result.errors}")
        }
}
