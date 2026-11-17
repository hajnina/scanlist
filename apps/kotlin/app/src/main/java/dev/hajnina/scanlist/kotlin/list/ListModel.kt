package dev.hajnina.scanlist.kotlin.list

import java.math.BigDecimal
import kotlin.math.abs
import kotlin.math.floor

// Model of the NORMATIVE list format (card S1): shared/spec/LIST.md §1-§4 + docs/list.schema.json.
// Field names and types mirror the schema 1:1 so parse -> model -> export is lossless. Nothing
// Kotlin-only is added to the persisted shape: `amount` stays a number|string union on purpose
// (LIST.md §3: readers MUST accept both and MUST NOT coerce one into the other), and `done` is the
// only mutable per-item state.

/** `amount`: a JSON number (quantity) or a JSON string (free text such as "2 packs"). Never coerced. */
sealed interface Amount {
    /** A JSON number. Kept as the decoded double; rendering/export use [formatJsonNumber]. */
    data class Num(val value: Double) : Amount

    /** A JSON string, used verbatim (LIST.md §3: "used verbatim (trimmed)"). */
    data class Text(val value: String) : Amount
}

/** One item (LIST.md §3). `id` may be absent: FLATTEN.md §3.2 derives one from path + name + index. */
data class ListItem(
    val id: String? = null,
    val name: String,
    val amount: Amount? = null,
    val unit: String? = null,
    val note: String? = null,
    val aliases: List<String> = emptyList(),
    val done: Boolean = false,
)

/** A section: items and sub-sections, recursive, any depth (LIST.md §2). */
data class ListSection(
    val name: String,
    val items: List<ListItem> = emptyList(),
    val sections: List<ListSection> = emptyList(),
)

/** A whole list (LIST.md §1). This data class is the round-trip unit of the card. */
data class ScanList(
    val title: String,
    val version: Int = 1,
    val sections: List<ListSection> = emptyList(),
)

// ---------------------------------------------------------------- rendering (LIST.md §4)

/**
 * Shortest round-trip decimal, JSON style (LIST.md §4): no "+", no exponent for |x| in
 * [1e-6, 1e15), "6" not "6.0", "0.5", "-2". Used for both display and export so the two can never
 * disagree.
 */
fun formatJsonNumber(x: Double): String {
    if (!x.isFinite()) return x.toString()
    if (x == 0.0) return "0"
    val a = abs(x)
    // Integral values below the exponent threshold print without a decimal point ("6", "-2").
    if (x == floor(x) && a < 1e15) return x.toLong().toString()
    if (a >= 1e-6 && a < 1e15) return BigDecimal(x.toString()).stripTrailingZeros().toPlainString()
    return x.toString()
}

/** `amountText` from LIST.md §4: "" when absent, trimmed free text, decimal for numbers. */
fun Amount.text(): String = when (this) {
    is Amount.Num -> formatJsonNumber(value)
    is Amount.Text -> value.trim()
}

/** `amountText` for an item: "" when the amount is absent. */
fun ListItem.amountText(): String = amount?.text() ?: ""

/** `displayText` from LIST.md §4: amount + unit, unit only when there is an amount. */
fun ListItem.displayText(): String {
    val amountText = amountText()
    val unit = unit?.trim().orEmpty()
    return if (amountText.isNotEmpty() && unit.isNotEmpty()) "$amountText $unit" else amountText
}

/** Item name as the UI shows it (trimmed); ids still derive from the verbatim name (FLATTEN.md §3.2). */
fun ListItem.displayName(): String = name.trim()

/** Note trimmed for display, null when absent or blank. Never part of [displayText] (LIST.md §4). */
fun ListItem.displayNote(): String? = note?.trim()?.takeIf { it.isNotEmpty() }
