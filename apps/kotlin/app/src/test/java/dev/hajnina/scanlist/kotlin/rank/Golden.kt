package dev.hajnina.scanlist.kotlin.rank

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.fail

/**
 * Model-free reader for `shared/fixtures/golden.json` (card S3), the fixture card B3's Done-when
 * names: item vectors + per-query vectors + the reference ranker's expected top-3 for all 58 queries
 * (5 lists, 88 items). No model, no device — JSON plus this test package.
 *
 * The vectors are final per RANK.md §2 (256-d, truncated, L2-normalised in float64, shortest
 * round-trip JSON), so parsing reproduces exactly the doubles the Python oracle used.
 */
object Golden {

    /** A flattened item exactly as `golden.json` stores it (FLATTEN.md §1, no `vec` key). */
    data class Item(
        val id: String,
        val name: String,
        val amount: Amount,
        val unit: String?,
        val note: String?,
        val aliases: List<String>,
        val done: Boolean,
        val path: List<String>,
        val pathText: String,
        val index: Int,
        val order: Int,
    ) {
        /**
         * `docText` recomputed from the fixture's own fields (FLATTEN.md §4 / `doc_text()` in
         * shared/ref/scanlist_ref.py): name; aliases (", "); path (" > "), "; " joined.
         * The fixture does not store docText, so this is what closes the Kotlin-flatten loop: if the
         * B2 flatten of the same JSON produces the same fields, it must produce this same docText,
         * which is the string the fixture's vectors were embedded from.
         */
        val referenceDocText: String
            get() {
                val parts = ArrayList<String>(3)
                if (name.isNotEmpty()) parts += name
                if (aliases.isNotEmpty()) parts += aliases.joinToString(", ")
                if (path.isNotEmpty()) parts += path.joinToString(" > ")
                return parts.joinToString("; ").trim()
            }
    }

    /** `amount` as the fixture stores it: a JSON number or a JSON string (LIST.md §3 union). */
    sealed interface Amount {
        data class Num(val value: Double) : Amount
        data class Text(val value: String) : Amount
        object Missing : Amount
    }

    data class ListFixture(
        val id: String,
        val source: String,
        val title: String,
        val itemCount: Int,
        val items: List<Item>,
        val itemVectors: Map<String, DoubleArray>,
    )

    data class Query(
        val id: String,
        val kind: String,
        val list: String,
        val expect: String,
        val text: String?,
        val vector: DoubleArray,
        val expectedTop3: List<String>,
        val expectedScores: List<Double>,
        val expectedMargin: Double?,
        /** Image queries only: the OFF product name recorded with the barcode (§6.3). */
        val product: String?,
        /** Image queries only: the EAN/UPC recorded with the frame. */
        val barcode: String?,
    )

    private val root: JsonObject by lazy {
        Json.parseToJsonElement(goldenFile().readText(Charsets.UTF_8)).jsonObject
    }

    val model: String by lazy { root["model"]!!.jsonObject["id"]!!.jsonPrimitive.content }

    val dims: Int by lazy { root["dims"]!!.jsonObject["active"]!!.jsonPrimitive.int }

    val docPrefix: String by lazy {
        root["prompts"]!!.jsonObject["doc"]!!.jsonPrimitive.content
    }

    val queryPrefix: String by lazy {
        root["prompts"]!!.jsonObject["query"]!!.jsonPrimitive.content
    }

    val lists: List<ListFixture> by lazy {
        root["lists"]!!.jsonArray.map { element ->
            val obj = element.jsonObject
            val id = obj.string("id")
            val items = obj["items"]!!.jsonArray.map { item(it.jsonObject) }
            val vectors = obj["itemVectors"]!!.jsonObject.mapValues { (_, vec) -> vector(vec) }
            ListFixture(
                id = id,
                source = obj.string("source"),
                title = obj.string("title"),
                itemCount = obj["itemCount"]!!.jsonPrimitive.int,
                items = items,
                itemVectors = vectors,
            )
        }
    }

    val queries: List<Query> by lazy {
        root["queries"]!!.jsonArray.map { element ->
            val obj = element.jsonObject
            Query(
                id = obj.string("id"),
                kind = obj.string("kind"),
                list = obj.string("list"),
                expect = obj.string("expect"),
                text = obj["text"]?.jsonPrimitive?.content,
                vector = vector(obj["vector"]!!),
                expectedTop3 = obj["expectedTop3"]!!.jsonArray.map { it.jsonPrimitive.content },
                expectedScores = obj["expectedScores"]!!.jsonArray.map { it.jsonPrimitive.content.toDouble() },
                expectedMargin = obj["expectedMargin"]?.jsonPrimitive?.content?.toDouble(),
                product = obj["product"]?.jsonPrimitive?.content,
                barcode = obj["barcode"]?.jsonPrimitive?.content,
            )
        }
    }

    fun list(id: String): ListFixture = lists.first { it.id == id }

    /** Ranker input for one fixture list (RANK.md §1: `vec` on the input items only). */
    fun rankItems(list: ListFixture): List<RankItem> = list.items.map { item ->
        RankItem(
            id = item.id,
            name = item.name,
            aliases = item.aliases,
            done = item.done,
            order = item.order,
            vec = list.itemVectors[item.id],
        )
    }

    private fun item(obj: JsonObject): Item = Item(
        id = obj.string("id"),
        name = obj.string("name"),
        amount = when (val amount = obj["amount"]) {
            null, is kotlinx.serialization.json.JsonNull -> Amount.Missing
            else -> {
                val primitive = (amount as JsonPrimitive)
                if (primitive.isString) Amount.Text(primitive.content) else Amount.Num(primitive.doubleOrNull ?: 0.0)
            }
        },
        unit = obj["unit"]?.jsonPrimitive?.takeIf { it.content != "null" }?.content,
        note = obj["note"]?.jsonPrimitive?.takeIf { it.content != "null" }?.content,
        aliases = obj["aliases"]!!.jsonArray.map { it.jsonPrimitive.content },
        done = obj["done"]!!.jsonPrimitive.booleanOrNull ?: false,
        path = obj["path"]!!.jsonArray.map { it.jsonPrimitive.content },
        pathText = obj.string("pathText"),
        index = obj["index"]!!.jsonPrimitive.int,
        order = obj["order"]!!.jsonPrimitive.int,
    )

    private fun vector(element: JsonElement): DoubleArray =
        element.jsonArray.map { (it as JsonPrimitive).content.toDouble() }.toDoubleArray()

    private fun JsonObject.string(key: String): String = this[key]!!.jsonPrimitive.content

    private fun goldenFile(): File {
        var candidate: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (candidate != null) {
            val file = File(candidate, "shared/fixtures/golden.json")
            if (file.isFile) return file
            candidate = candidate.parentFile
        }
        fail("could not find shared/fixtures/golden.json above ${System.getProperty("user.dir")}")
        error("unreachable")
    }

    /** The four sample lists' nested JSON (the flatten test parses these with B2's JSON layer). */
    fun sampleJson(source: String): String {
        var candidate: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (candidate != null) {
            val file = File(candidate, source)
            if (file.isFile) return file.readText(Charsets.UTF_8)
            candidate = candidate.parentFile
        }
        fail("could not find $source above ${System.getProperty("user.dir")}")
        error("unreachable")
    }

    /** Sanity: the fixture is the one the card describes (88 items in 5 lists, 58 queries). */
    fun checkShape() {
        check(lists.size == 5) { "expected 5 lists, found ${lists.size}" }
        check(lists.sumOf { it.items.size } == 88) { "expected 88 items" }
        check(lists.sumOf { it.items.size } == lists.sumOf { it.itemVectors.size }) { "item vector table is incomplete" }
        check(queries.size == 58) { "expected 58 queries, found ${queries.size}" }
        check(lists.all { it.itemCount == it.items.size }) { "itemCount disagrees with items" }
    }
}
