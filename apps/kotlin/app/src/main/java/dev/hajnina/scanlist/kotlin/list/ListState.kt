package dev.hajnina.scanlist.kotlin.list

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

// Thin Compose state holder over ListRepository. The UI reads it, calls one method per action, and
// re-renders: every rule (validate, persist, tick, export) lives in the tested plain-Kotlin layer.

class ListState internal constructor(private val repository: ListRepository) {

    /** All stored lists, newest first. */
    var lists by mutableStateOf<List<StoredList>>(emptyList())
        private set

    /** Import errors (JSON pointers from LIST.md §5); shown in a dialog, cleared on dismiss. */
    var errors by mutableStateOf<List<String>>(emptyList())
        private set

    /** One-line feedback for the current screen ("Imported …", "Saved …"). */
    var note by mutableStateOf<String?>(null)
        private set

    /** The list created by the most recent successful import (the home screen opens it). */
    var lastImported by mutableStateOf<StoredList?>(null)
        private set

    fun refresh() {
        lists = repository.loadAll()
    }

    fun get(listId: String): StoredList? = lists.firstOrNull { it.id == listId } ?: repository.get(listId)

    /** Import JSON text from a file or the paste dialog. Returns true on success. */
    fun import(text: String): Boolean = when (val result = repository.import(text)) {
        is ImportResult.Ok -> {
            errors = emptyList()
            note = "Imported ${result.stored.list.title}"
            lastImported = result.stored
            refresh()
            true
        }
        is ImportResult.Invalid -> {
            errors = result.errors
            note = null
            false
        }
    }

    fun toggle(listId: String, itemId: String) {
        repository.toggle(listId, itemId)
        refresh()
    }

    fun delete(listId: String) {
        repository.delete(listId)
        refresh()
    }

    fun exportJson(listId: String): String? = repository.exportJson(listId)

    /** Drop the failure dialog (dismiss/OK). */
    fun clearErrors() {
        errors = emptyList()
    }

    fun say(text: String) {
        note = text
    }

    /** Home screen consumed the "just imported" signal (it opened the new list). */
    fun consumeLastImported() {
        lastImported = null
    }

    fun clearNote() {
        note = null
    }

    /** Total items and ticked count across every list, for the home hero card. */
    fun totals(): Pair<Int, Int> {
        var total = 0
        var ticked = 0
        lists.forEach { stored ->
            val flat = stored.list.flatten()
            total += flat.size
            ticked += flat.count { it.done }
        }
        return total to ticked
    }
}

/** Files-dir-backed state, remembered for the lifetime of the composition. */
@Composable
fun rememberListState(): ListState {
    val context = LocalContext.current
    return remember(context) {
        val repository = ListRepository(ListRepository.storeFor(context.filesDir))
        ListState(repository).also { it.refresh() }
    }
}
