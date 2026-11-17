package dev.hajnina.scanlist.kotlin.list

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** shared/spec/FLATTEN.md: ids (with the spec's worked vectors), order, docText, alias dedupe. */
class ListFlattenTest {

    @Test
    fun `worked derived-id vectors from the spec`() {
        assertEquals("sha1:2f551506bf4e121abecf1480482d5674359ee397", derivedId(emptyList(), "Milk", 0))
        assertEquals("sha1:19d895a3b978a4e00caccc2f20ce35044c83cd28", derivedId(listOf("Pantry"), "Pasta", 0))
        assertEquals(
            "sha1:998e2c1acb80597f39892b85f9dfa8726ead298e",
            derivedId(listOf("Fresh", "Fruit & veg"), "Bananas", 0),
        )
        assertEquals(
            "sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3",
            derivedId(listOf("Fresh", "Fruit & veg"), "Tomatoes", 1),
        )
        assertEquals(
            "sha1:cfc789c216b0dd286fa1f6f40592e8db7aeb7197",
            derivedId(listOf("A", "B", "C", "D"), "Nutmeg", 2),
        )
    }

    @Test
    fun `sha1 hex is lowercase and matches the spec key`() {
        val hex = sha1Hex("Milk#0")
        assertEquals(40, hex.length)
        assertEquals(hex.lowercase(), hex)
        assertEquals("2f551506bf4e121abecf1480482d5674359ee397", hex)
    }

    @Test
    fun `van weekly flattens depth-first, items before sub-sections`() {
        val flat = parse(Samples.read("van-weekly.json")).flatten()
        assertEquals(
            listOf(
                "Bananas", "Tomatoes", "Avocado", // Fresh > Fruit & veg
                "Oat milk", "Greek yoghurt", // Fresh > Dairy
                "Pasta", "Olive oil", "Coffee beans", // Pantry
                "Dish soap", "Toilet paper", // Household
            ),
            flat.map { it.name },
        )
        assertEquals((0 until 10).toList(), flat.map { it.order })
        assertEquals("Fresh > Fruit & veg", flat[0].pathText)
        assertEquals(listOf("Fresh", "Dairy"), flat[3].path)
        assertEquals(0, flat[3].index) // index inside its own section (Dairy's first item)
        assertEquals(0, flat[0].index)
        // The spec's sample-path vector for Bananas is the id the flattener must produce.
        assertEquals("sha1:998e2c1acb80597f39892b85f9dfa8726ead298e", flat[0].id)
        assertEquals("sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3", flat[1].id)
        assertEquals(listOf("Fresh", "Dairy", "Oat milk"), flat[3].path + flat[3].name)
    }

    @Test
    fun `docText is name, aliases, path with the spec's separators`() {
        val flat = parse(Samples.read("van-weekly.json")).flatten()
        assertEquals("Bananas; Fresh > Fruit & veg", flat.first { it.name == "Bananas" }.docText())
        assertEquals("Tomatoes; tomates; Fresh > Fruit & veg", flat.first { it.name == "Tomatoes" }.docText())
        assertEquals("Oat milk; bebida de avena; Fresh > Dairy", flat.first { it.name == "Oat milk" }.docText())

        // Root item: no path part at all.
        val root = parse("""{"title":"T","sections":[{"name":"S","items":[{"name":"Milk"}]}]}""")
            .flatten().first().copy(path = emptyList(), pathText = "")
        assertEquals("Milk", root.docText())
    }

    @Test
    fun `deep nesting produces one entry per item with full paths`() {
        val flat = parse(Samples.read("deep-nesting.json")).flatten()
        assertEquals(10, flat.size)
        val cumin = flat.first { it.name == "Cumin" }
        assertEquals("Home > Kitchen > Pantry > Spices", cumin.pathText)
        assertEquals(4, cumin.path.size)
        assertEquals("spice-cumin", cumin.id)
        assertEquals("Basmati rice", flat[3].name)
        assertEquals("Home > Kitchen > Pantry > Dry goods", flat[3].pathText)
    }

    @Test
    fun `duplicate explicit ids are renamed in traversal order`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"S","items":[
                {"id":"milk","name":"Milk"},{"name":"Bread"},{"id":"milk","name":"Whole milk"}]}]}""",
        )
        assertEquals(listOf("milk", "sha1:" + sha1Hex("S/Bread#1"), "milk~2"), list.flatten().map { it.id })
    }

    @Test
    fun `duplicate names in one section get distinct ids`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"S","items":[{"name":"Milk"},{"name":"Milk"}]}]}""",
        )
        val ids = list.flatten().map { it.id }
        assertEquals(2, ids.toSet().size)
        assertNotEquals(ids[0], ids[1])
        assertEquals("sha1:" + sha1Hex("S/Milk#0"), ids[0])
        assertEquals("sha1:" + sha1Hex("S/Milk#1"), ids[1])
    }

    @Test
    fun `item name whitespace is trimmed for display but kept verbatim in the id key`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"S","items":[{"name":"  Milk  "}]}]}""",
        )
        val item = list.flatten().single()
        assertEquals("Milk", item.name)
        assertEquals("sha1:" + sha1Hex("S/  Milk  #0"), item.id)
        assertEquals("Milk; S", item.docText())
    }

    @Test
    fun `explicit ids are trimmed and used verbatim`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"S","items":[{"id":"  Milk-1  ","name":"Milk"},{"id":"   ","name":"Bread"}]}]}""",
        )
        val flat = list.flatten()
        assertEquals("Milk-1", flat[0].id)
        assertEquals("sha1:" + sha1Hex("S/Bread#1"), flat[1].id)
    }

    @Test
    fun `aliases are trimmed, empties dropped and deduped case-insensitively`() {
        assertEquals(listOf("Leche"), normaliseAliases(listOf("Leche", "leche", "Leche ")))
        assertEquals(listOf("Tomates", "rajčata"), normaliseAliases(listOf(" Tomates ", "rajčata", "  ")))
        // Case-insensitive dedupe (FLATTEN.md §5) collapses a capitalised duplicate and keeps
        // the first spelling; aliases are never lowercased for storage/display.
        assertEquals(listOf("mléko"), normaliseAliases(listOf("mléko", "Mléko")))
    }

    @Test
    fun `flatten normalises aliases but the stored model keeps its spelling`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"S","items":[{"name":"Milk","aliases":["Leche","  ","leche"]}]}]}""",
        )
        assertEquals(listOf("Leche"), list.flatten().single().aliases)
        assertEquals(listOf("Leche", "leche"), list.sections[0].items[0].aliases)
    }

    @Test
    fun `empty sections contribute nothing`() {
        val list = parse(
            """{"title":"T","sections":[{"name":"A"},{"name":"B","items":[],"sections":[]},
                {"name":"C","sections":[{"name":"C1"}]}]}""",
        )
        assertEquals(emptyList<FlatItem>(), list.flatten())
    }

    @Test
    fun `index path map agrees with flatten ids and ticks the right item`() {
        val list = parse(Samples.read("deep-nesting.json"))
        val index = list.flatIndex()
        assertEquals(index.items, list.flatten())

        // Home > Kitchen > Pantry > Spices is section path [0,0,0,0]; Cumin is item 0 there.
        assertEquals("spice-cumin", index.idAt(listOf(0, 0, 0, 0), 0))
        assertEquals("Smoked paprika", index.items.first { it.id == index.idAt(listOf(0, 0, 0, 0), 1) }.name)
        // Home > Kitchen > Pantry > Dry goods is [0,0,0,1]; "Red lentils" is item 1 there and is ticked.
        assertEquals(true, index.items.first { it.id == index.idAt(listOf(0, 0, 0, 1), 1) }.done)
        assertEquals(null, index.idAt(listOf(9, 9), 0))

        // Every item in the tree is reachable through the map, and the map holds only real ids.
        val seen = mutableSetOf<String>()
        fun walk(section: ListSection, path: List<Int>) {
            section.items.indices.forEach { seen += index.idAt(path, it)!! }
            section.sections.forEachIndexed { childIndex, child -> walk(child, path + childIndex) }
        }
        list.sections.forEachIndexed { sectionIndex, section -> walk(section, listOf(sectionIndex)) }
        assertEquals(index.items.map { it.id }.toSet(), seen)
    }

    @Test
    fun `toggleItem flips done by id and leaves everything else alone`() {
        val list = parse(Samples.read("van-weekly.json"))
        val bananas = list.flatten().first { it.name == "Bananas" }
        val ticked = list.withItemDone(bananas.id, true)
        assertTrue(ticked.flatten().first { it.name == "Bananas" }.done)
        assertEquals(
            list.flatten().map { it.copy(done = false) },
            ticked.flatten().map { it.copy(done = false) },
        )
        assertEquals(list.flatten().map { it.id }, ticked.flatten().map { it.id })

        val unticked = ticked.toggleItem(bananas.id)
        assertTrue(!unticked!!.flatten().first { it.name == "Bananas" }.done)
        assertEquals(null, list.toggleItem("no-such-id"))
    }

    private fun parse(text: String): ScanList =
        when (val result = ListJson.parse(text)) {
            is ListJson.ParseResult.Ok -> result.list
            is ListJson.ParseResult.Invalid -> error("parse failed: ${result.errors}")
        }
}
