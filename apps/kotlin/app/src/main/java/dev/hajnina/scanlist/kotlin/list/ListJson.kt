package dev.hajnina.scanlist.kotlin.list

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.floor

// JSON parse / validate / export for the normative list format: shared/spec/LIST.md §1-§7,
// docs/list.schema.json. Import errors are RFC 6901 JSON pointers (§5: "each error names a JSON
// pointer"), and export emits the SAME shape as import, so import -> tick -> export round-trips.
//
// Deliberately the kotlinx.serialization *tree* API (JsonElement): the amount union needs the
// number-vs-string distinction preserved exactly, which is one line here and a custom serializer
// otherwise. No @Serializable classes and no serialization compiler plugin are needed, so the
// module keeps S9's "plugin pins are root-owned" contract.

@OptIn(ExperimentalSerializationApi::class)
object ListJson {

    /** Result of parsing one document (LIST.md §5: Ok or Error, never a partial import). */
    sealed interface ParseResult {
        data class Ok(val list: ScanList) : ParseResult
        data class Invalid(val errors: List<String>) : ParseResult
    }

    private val parser = Json {
        ignoreUnknownKeys = true
        isLenient = false
        allowSpecialFloatingPointValues = false
    }

    private val pretty = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
    }

    private val compact = Json { }

    /** Parse + validate. Accepts exactly the LIST.md shape; unknown fields are ignored (§6). */
    fun parse(text: String): ParseResult {
        val root = try {
            parser.parseToJsonElement(text)
        } catch (t: Throwable) {
            return ParseResult.Invalid(listOf("/: not valid JSON (${t.message})"))
        }
        val validator = Validator()
        val list = validator.list(root)
        return if (validator.errors.isEmpty() && list != null) {
            ParseResult.Ok(list)
        } else {
            // Defensive: a null list without a recorded error still produces a pointer-named error.
            ParseResult.Invalid(
                validator.errors.ifEmpty { listOf("/: not a list object") },
            )
        }
    }

    /** Convenience: the errors of a failed parse, empty when it succeeded. */
    fun errorsOf(result: ParseResult): List<String> = when (result) {
        is ParseResult.Ok -> emptyList()
        is ParseResult.Invalid -> result.errors
    }

    /**
     * Export the same JSON shape (LIST.md §7): title, version, sections of {name, items, sections};
     * per item at least `name`, plus id/amount/unit/note/aliases when present and `"done": true`
     * for ticked items. Section and item order is preserved exactly (it is the ranking tie-breaker).
     */
    fun encode(list: ScanList, prettyPrint: Boolean = true): String {
        val format = if (prettyPrint) pretty else compact
        return format.encodeToString(JsonElement.serializer(), list.toJson())
    }

    private fun ScanList.toJson(): JsonObject = buildJsonObject {
        put("title", title)
        put("version", version)
        put("sections", buildJsonArray { sections.forEach { add(it.toJson()) } })
    }

    private fun ListSection.toJson(): JsonObject = buildJsonObject {
        put("name", name)
        if (items.isNotEmpty()) put("items", buildJsonArray { items.forEach { add(it.toJson()) } })
        if (sections.isNotEmpty()) put("sections", buildJsonArray { sections.forEach { add(it.toJson()) } })
    }

    private fun ListItem.toJson(): JsonObject = buildJsonObject {
        id?.let { put("id", it) }
        put("name", name)
        when (val a = amount) {
            // Integral numbers keep the JSON spelling "6" (LIST.md §4 shortest round-trip decimal)
            // instead of kotlinx's "6.0"; fractional values are emitted as the shortest double.
            is Amount.Num -> if (a.value == floor(a.value) && abs(a.value) < 1e15) {
                put("amount", a.value.toLong())
            } else {
                put("amount", a.value)
            }
            is Amount.Text -> put("amount", a.value)
            null -> Unit
        }
        unit?.let { put("unit", it) }
        note?.let { put("note", it) }
        if (aliases.isNotEmpty()) put("aliases", buildJsonArray { aliases.forEach { add(JsonPrimitive(it)) } })
        if (done) put("done", true)
    }

    // ------------------------------------------------------------ validation (LIST.md §1-§6)

    /**
     * Walks the tree once, recording RFC 6901 pointers and building the model. Everything that is
     * not a schema-valid list is reported, never repaired: a wrong type (e.g. `"amount": null`,
     * `"aliases": "milk"`, `"done": "yes"`) is an error, while an unknown key is ignored.
     */
    private class Validator {
        val errors = mutableListOf<String>()

        private fun fail(pointer: String, message: String) {
            errors += "${if (pointer.isEmpty()) "/" else pointer}: $message"
        }

        fun list(root: JsonElement): ScanList? {
            val obj = root as? JsonObject ?: run {
                fail("", "expected a JSON object")
                return null
            }

            val title = stringField(obj, "title", "/title", required = true)
            val versionValue = obj["version"]
            val version = if (versionValue == null) {
                1
            } else {
                val primitive = versionValue as? JsonPrimitive
                val intValue = if (primitive != null && !primitive.isString && primitive !is JsonNull) {
                    primitive.content.toIntOrNull()
                } else {
                    null
                }
                if (intValue == null) {
                    fail("/version", "expected an integer")
                    1
                } else {
                    intValue
                }
            }

            val sectionsElement = obj["sections"]
            val sections = if (sectionsElement == null) {
                fail("/sections", "required")
                emptyList()
            } else {
                sectionArray(sectionsElement, "/sections")
            }

            if (title == null) return null
            return ScanList(title = title, version = version, sections = sections)
        }

        private fun sectionArray(element: JsonElement, pointer: String): List<ListSection> {
            val array = element as? JsonArray ?: run {
                fail(pointer, "expected an array of sections")
                return emptyList()
            }
            return array.mapIndexedNotNull { index, child -> section(child, "$pointer/$index") }
        }

        private fun section(element: JsonElement, pointer: String): ListSection? {
            val obj = element as? JsonObject ?: run {
                fail(pointer, "expected a section object")
                return null
            }
            val name = stringField(obj, "name", "$pointer/name", required = true)

            val itemsElement = obj["items"]
            val items = when {
                itemsElement == null -> emptyList()
                itemsElement is JsonArray -> itemsElement.mapIndexedNotNull { index, child ->
                    item(child, "$pointer/items/$index")
                }
                else -> {
                    fail("$pointer/items", "expected an array of items")
                    emptyList()
                }
            }

            val subSectionsElement = obj["sections"]
            val subSections = when {
                subSectionsElement == null -> emptyList()
                subSectionsElement is JsonArray -> sectionArray(subSectionsElement, "$pointer/sections")
                else -> {
                    fail("$pointer/sections", "expected an array of sections")
                    emptyList()
                }
            }

            if (name == null) return null
            return ListSection(name = name, items = items, sections = subSections)
        }

        private fun item(element: JsonElement, pointer: String): ListItem? {
            val obj = element as? JsonObject ?: run {
                fail(pointer, "expected an item object")
                return null
            }

            val name = stringField(obj, "name", "$pointer/name", required = true)
            val id = stringField(obj, "id", "$pointer/id", required = false)
            val unit = stringField(obj, "unit", "$pointer/unit", required = false)
            // LIST.md §3 does not ask for notes to be normalised: keep them verbatim (display trims).
            val note = stringField(obj, "note", "$pointer/note", required = false, trim = false)

            val amountValue = obj["amount"]
            val amount = when (amountValue) {
                null -> null
                is JsonPrimitive -> when {
                    amountValue is JsonNull -> {
                        fail("$pointer/amount", "expected a number or a string, not null")
                        null
                    }
                    amountValue.isString -> {
                        val text = amountValue.content.trim()
                        if (text.isEmpty()) null else Amount.Text(text)
                    }
                    else -> amountValue.content.toDoubleOrNull()?.takeIf { it.isFinite() }?.let { Amount.Num(it) } ?: run {
                        // Non-finite guard: "1e999" parses as Double.POSITIVE_INFINITY, which the
                        // encoder rejects later with an unhandled JsonEncodingException — the error
                        // must surface here instead, as a pointered import error (LIST.md §5).
                        fail("$pointer/amount", "expected a finite number or a string")
                        null
                    }
                }
                else -> {
                    fail("$pointer/amount", "expected a number or a string")
                    null
                }
            }

            val aliasesValue = obj["aliases"]
            val aliases = when (aliasesValue) {
                null -> emptyList()
                is JsonArray -> aliasesValue.mapIndexedNotNull { index, alias ->
                    val primitive = alias as? JsonPrimitive
                    if (primitive == null || !primitive.isString || alias is JsonNull) {
                        fail("$pointer/aliases/$index", "expected a string")
                        null
                    } else {
                        // LIST.md §3: entries that are empty/whitespace-only are ignored (as if
                        // absent). Non-blank aliases are kept verbatim — they are case-sensitive
                        // data; trimming/deduping happens in the flattener (FLATTEN.md §5).
                        primitive.content.takeIf { it.isNotBlank() }
                    }
                }
                else -> {
                    fail("$pointer/aliases", "expected an array of strings")
                    emptyList()
                }
            }

            val doneValue = obj["done"]
            val done = when {
                doneValue == null -> false
                doneValue is JsonPrimitive && !doneValue.isString && doneValue !is JsonNull -> {
                    when (doneValue.content) {
                        "true" -> true
                        "false" -> false
                        else -> {
                            fail("$pointer/done", "expected a boolean")
                            false
                        }
                    }
                }
                else -> {
                    fail("$pointer/done", "expected a boolean")
                    false
                }
            }

            if (name == null) return null
            return ListItem(
                id = id,
                name = name,
                amount = amount,
                unit = unit,
                note = note,
                aliases = aliases,
                done = done,
            )
        }

        /**
         * Optional/required string field. Absent optional fields return null (default per LIST.md);
         * a blank id/unit is treated as absent (§3), while a blank title/section name is an error
         * (both are "non-empty after trim" in the schema).
         */
        private fun stringField(
            obj: JsonObject,
            key: String,
            pointer: String,
            required: Boolean,
            trim: Boolean = true,
        ): String? {
            val value = obj[key]
            if (value == null) {
                if (required) fail(pointer, "required")
                return null
            }
            val primitive = value as? JsonPrimitive
            if (primitive == null || !primitive.isString || value is JsonNull) {
                fail(pointer, "expected a string")
                return null
            }
            val text = primitive.content
            if (required && text.trim().isEmpty()) {
                fail(pointer, "must not be empty")
                return null
            }
            if (!required) {
                return if (trim) text.trim().takeIf { it.isNotEmpty() } else text
            }
            return text
        }
    }
}
