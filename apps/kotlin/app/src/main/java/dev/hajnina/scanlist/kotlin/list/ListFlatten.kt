package dev.hajnina.scanlist.kotlin.list

import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale

// Flattening, ids and embedding text: shared/spec/FLATTEN.md (normative). Depth-first pre-order,
// a section's own items before its sub-sections, derived ids = "sha1:" + sha1(pathKey + name + "#i"),
// collision renaming with "~2", "~3", ... in traversal order, and docText = name; aliases; path.
// The reference implementation is FLATTEN.md §6 (Python) — this file mirrors it line for line.

/** One flattened item (FLATTEN.md §1). `amount` keeps its JSON type, never coerced. */
data class FlatItem(
    val id: String,
    val name: String,
    val amount: Amount?,
    val unit: String?,
    val note: String?,
    val aliases: List<String>,
    val done: Boolean,
    val path: List<String>,
    val pathText: String,
    val index: Int,
    val order: Int,
)

/**
 * Flattened list plus the id of every item keyed by its section index path (section indexes, then
 * the item index). The map exists so the nested UI can tick the exact item without re-deriving ids,
 * and it is produced by the SAME walk as [flatten], so collision renaming can never disagree.
 */
class FlatIndex internal constructor(
    val items: List<FlatItem>,
    private val byIndexPath: Map<List<Int>, String>,
) {
    /** id of the item at [sectionPath] (0-based section indexes from the root) with [itemIndex]. */
    fun idAt(sectionPath: List<Int>, itemIndex: Int): String? = byIndexPath[sectionPath + itemIndex]

    operator fun get(itemId: String): FlatItem? = items.firstOrNull { it.id == itemId }
}

/** FLATTEN.md §2/§3: one pass, flatten order, ids unique in the list. */
fun ScanList.flatten(): List<FlatItem> = flatIndex().items

/** Flatten order + the index-path -> id map used by the nested UI ([FlatIndex.idAt]). */
fun ScanList.flatIndex(): FlatIndex {
    val items = ArrayList<FlatItem>()
    val byIndexPath = HashMap<List<Int>, String>()
    val used = HashSet<String>()

    fun walk(section: ListSection, path: List<String>, sectionPath: List<Int>) {
        section.items.forEachIndexed { index, item ->
            val base = explicitId(item) ?: derivedId(path, item.name, index)
            var candidate = base
            var suffix = 2
            while (candidate in used) {
                candidate = "$base~$suffix"
                suffix += 1
            }
            used += candidate
            byIndexPath[sectionPath + index] = candidate
            items += FlatItem(
                id = candidate,
                name = item.name.trim(),
                amount = item.amount,
                unit = item.unit?.trim()?.takeIf { it.isNotEmpty() },
                note = item.note?.trim()?.takeIf { it.isNotEmpty() },
                aliases = normaliseAliases(item.aliases),
                done = item.done,
                path = path,
                pathText = path.joinToString(" > "),
                index = index,
                order = items.size,
            )
        }
        section.sections.forEachIndexed { childIndex, child ->
            walk(child, path + child.name, sectionPath + childIndex)
        }
    }

    sections.forEachIndexed { index, section ->
        walk(section, listOf(section.name), listOf(index))
    }
    return FlatIndex(items, byIndexPath)
}

/** FLATTEN.md §4 `docText`: name, then aliases, then the section path; ";" + " " separators. */
fun FlatItem.docText(): String {
    val parts = ArrayList<String>(3)
    if (name.isNotEmpty()) parts += name
    if (aliases.isNotEmpty()) parts += aliases.joinToString(", ")
    if (path.isNotEmpty()) parts += path.joinToString(" > ")
    return parts.joinToString("; ").trim()
}

/** FLATTEN.md §3.1: an explicit id wins when its trimmed value is non-empty. */
internal fun explicitId(item: ListItem): String? = item.id?.trim()?.takeIf { it.isNotEmpty() }

/** FLATTEN.md §3.2: derived id from the verbatim path/name and the item's index in its section. */
internal fun derivedId(path: List<String>, name: String, index: Int): String {
    val pathKey = path.joinToString("/")
    val key = (if (pathKey.isEmpty()) "" else "$pathKey/") + name + "#" + index
    return "sha1:" + sha1Hex(key)
}

/** Lowercase hex SHA-1 over the UTF-8 bytes (FLATTEN.md §3.2). Also the cache-key primitive (RANK.md §2.1). */
fun sha1Hex(text: String): String {
    val digest = MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8))
    val out = StringBuilder(digest.size * 2)
    digest.forEach { byte ->
        val v = byte.toInt() and 0xff
        out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
    }
    return out.toString()
}

private const val HEX = "0123456789abcdef"

/**
 * FLATTEN.md §5: trim, drop empties, dedupe case-insensitively after NFC normalisation, keeping the
 * first occurrence's spelling and order. Kotlin has no `str.casefold()`, so this uses
 * `lowercase(Locale.ROOT)` (the same approximation RANK.md §3.1 requires all tracks to share).
 */
fun normaliseAliases(aliases: List<String>): List<String> {
    val seen = HashSet<String>()
    val out = ArrayList<String>(aliases.size)
    aliases.forEach { raw ->
        val alias = raw.trim()
        if (alias.isEmpty()) return@forEach
        val key = Normalizer.normalize(alias, Normalizer.Form.NFC).lowercase(Locale.ROOT)
        if (seen.add(key)) out += alias
    }
    return out
}
