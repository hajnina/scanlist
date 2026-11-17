package dev.hajnina.scanlist.kotlin.list

// Item edits on the nested tree. The only mutable per-item state is `done` (LIST.md §3), so this
// is the whole edit surface of card B2. Ids are assigned with the FLATTEN.md §3 algorithm in
// traversal order, so ticking by id can never hit the wrong item when names repeat.

/** Id of the item that [transform] matches, or null when the id is not in this list. */
internal fun ScanList.toggleItem(itemId: String): ScanList? {
    val current = flatten().firstOrNull { it.id == itemId } ?: return null
    return withItemDone(itemId, !current.done)
}

/**
 * Returns a copy of this list with the item whose flattened id is [itemId] marked [done].
 * Unknown ids return the list unchanged (the UI can hold an id across a reload).
 */
fun ScanList.withItemDone(itemId: String, done: Boolean): ScanList {
    val used = HashSet<String>()

    fun walk(section: ListSection, path: List<String>): ListSection {
        val items = section.items.mapIndexed { index, item ->
            val base = explicitId(item) ?: derivedId(path, item.name, index)
            var candidate = base
            var suffix = 2
            while (candidate in used) {
                candidate = "$base~$suffix"
                suffix += 1
            }
            used += candidate
            if (candidate == itemId) item.copy(done = done) else item
        }
        val children = section.sections.map { walk(it, path + it.name) }
        return section.copy(items = items, sections = children)
    }

    return copy(sections = sections.map { walk(it, listOf(it.name)) })
}

/** Number of items in the whole tree, ticked or not. */
fun ScanList.itemCount(): Int = flatten().size

/** Number of items still to buy (progress numerator for the hero card). */
fun ScanList.tickedCount(): Int = flatten().count { it.done }

/** Items in this section's subtree (its own items plus every sub-section's), for section headers. */
fun ListSection.totalItems(): Int = items.size + sections.sumOf { it.totalItems() }

/** Ticked items in this section's subtree. */
fun ListSection.doneItems(): Int = items.count { it.done } + sections.sumOf { it.doneItems() }
