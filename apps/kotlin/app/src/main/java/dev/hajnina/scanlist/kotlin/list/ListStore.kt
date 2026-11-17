package dev.hajnina.scanlist.kotlin.list

import java.io.File
import java.util.Locale

// Persistence: one UTF-8 JSON file per list, written with the SAME codec as export
// (shared/spec/LIST.md §7). That is the whole round-trip contract on disk — the stored file is
// byte-identical to an exported file, so "persist then export" cannot drift.
//
// Chosen over androidx DataStore because the card's format IS a JSON document: a file per list keeps
// the normative shape visible (`filesDir/lists/<id>.json`), makes the whole persistence layer plain
// java.io (and therefore JVM-unit-testable, card B2 Done-when), and adds no dependency. Writes are
// atomic (tmp file + rename) so a kill mid-write cannot truncate a list.

/** A list as loaded from / saved to disk. [id] is the file name stem, never part of the JSON. */
data class StoredList(
    val id: String,
    val list: ScanList,
    val updatedAt: Long = 0L,
)

/** File-backed store of lists under `<root>/lists/<id>.json`. No Android APIs: JVM-testable. */
class ListStore(private val root: File) {

    private val listsDir: File get() = File(root, "lists")

    /** All stored ids, stable order (file name ascending). */
    fun ids(): List<String> = listsDir.listFiles()
        ?.filter { it.isFile && it.name.endsWith(SUFFIX) }
        ?.map { it.name.removeSuffix(SUFFIX) }
        ?.sorted()
        .orEmpty()

    /** Load one list, or null when it is missing or no longer parses (no partial loads). */
    fun load(id: String): StoredList? {
        val file = fileFor(id)
        if (!file.isFile) return null
        val text = runCatching { file.readText(Charsets.UTF_8) }.getOrNull() ?: return null
        val list = when (val parsed = ListJson.parse(text)) {
            is ListJson.ParseResult.Ok -> parsed.list
            is ListJson.ParseResult.Invalid -> return null
        }
        return StoredList(id = id, list = list, updatedAt = file.lastModified())
    }

    /** Every list that still parses, newest first (the lists screen order). */
    fun loadAll(): List<StoredList> = ids()
        .mapNotNull { load(it) }
        .sortedWith(compareByDescending<StoredList> { it.updatedAt }.thenBy { it.id })

    /** Write [list] as `<id>.json`, atomically. Returns the target file. */
    fun save(id: String, list: ScanList): File {
        require(isValidId(id)) { "invalid list id: $id" }
        listsDir.mkdirs()
        val target = fileFor(id)
        val tmp = File(listsDir, "$id$SUFFIX.tmp")
        tmp.writeText(ListJson.encode(list, prettyPrint = true) + "\n", Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            // renameTo can fail across mounts; fall back to a copy + delete.
            target.writeText(tmp.readText(Charsets.UTF_8), Charsets.UTF_8)
            tmp.delete()
        }
        return target
    }

    fun delete(id: String): Boolean = fileFor(id).delete()

    /** True for ids this store wrote (slug/dash/number) — never a path traversal. */
    fun isValidId(id: String): Boolean = id.isNotEmpty() && id.length <= 64 &&
        id.all { it.isLetterOrDigit() || it == '-' || it == '_' }

    private fun fileFor(id: String): File = File(listsDir, id + SUFFIX)

    companion object {
        const val SUFFIX = ".json"
    }
}

/** How an import went (LIST.md §5: Ok or Error, no partial import). */
sealed interface ImportResult {
    data class Ok(val stored: StoredList) : ImportResult
    data class Invalid(val errors: List<String>) : ImportResult
}

/**
 * Import / tick / export over a [ListStore]. Pure Kotlin (no Android, no Compose) so the card's
 * Done-when is a JVM unit test: parse every shared sample, persist, tick, export, re-import.
 */
class ListRepository(private val store: ListStore) {

    /** All stored lists, newest first. */
    fun loadAll(): List<StoredList> = store.loadAll()

    fun get(id: String): StoredList? = store.load(id)

    /**
     * Import a list from JSON text. A list may be imported any number of times (LIST.md §6: the app
     * does not deduplicate), so the id is a fresh slug for every successful import.
     */
    fun import(text: String): ImportResult {
        return when (val parsed = ListJson.parse(text)) {
            is ListJson.ParseResult.Invalid -> ImportResult.Invalid(parsed.errors)
            is ListJson.ParseResult.Ok -> {
                val id = newId(parsed.list.title)
                store.save(id, parsed.list)
                ImportResult.Ok(StoredList(id, parsed.list, updatedAt = System.currentTimeMillis()))
            }
        }
    }

    /** Toggle one item by its flattened id and persist. Returns the new list, null if unknown. */
    fun toggle(listId: String, itemId: String): ScanList? {
        val stored = store.load(listId) ?: return null
        val updated = stored.list.toggleItem(itemId) ?: return null
        store.save(listId, updated)
        return updated
    }

    /** Same as [toggle] but explicit, for a UI that knows the target state. */
    fun setDone(listId: String, itemId: String, done: Boolean): ScanList? {
        val stored = store.load(listId) ?: return null
        val updated = stored.list.withItemDone(itemId, done)
        store.save(listId, updated)
        return updated
    }

    /** Export the list as the normative JSON (LIST.md §7), including `done` flags. */
    fun exportJson(listId: String): String? = store.load(listId)?.let { ListJson.encode(it.list) }

    fun delete(listId: String): Boolean = store.delete(listId)

    /** Slug of the title plus the first free numeric suffix ("weekly-shop", "weekly-shop-2", ...). */
    internal fun newId(title: String): String {
        val slug = title.trim().lowercase(Locale.ROOT)
            .map { if (it.isLetterOrDigit()) it else '-' }
            .joinToString("")
            .trim('-')
            .ifEmpty { "list" }
            .take(40)
        val existing = store.ids().toSet()
        if (slug !in existing) return slug
        var n = 2
        while ("$slug-$n" in existing) n += 1
        return "$slug-$n"
    }

    companion object {
        /** Standard location: `<filesDir>/lists/<id>.json`. */
        fun storeFor(filesDir: File): ListStore = ListStore(filesDir)
    }
}
