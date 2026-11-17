package dev.hajnina.scanlist.kotlin

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.hajnina.scanlist.kotlin.list.ListDetailScreen
import dev.hajnina.scanlist.kotlin.list.ListsHomeScreen
import dev.hajnina.scanlist.kotlin.list.rememberListState

/** Top-level destinations. List is pushed from Lists (see [ScanListApp]). */
enum class Tab(val label: String) {
    Lists("Lists"),
    Scan("Scan"),
    Settings("Settings"),
}

/**
 * Root shell: one scrolling screen body + an expressive pill tab bar, edge-to-edge like Bonsai
 * (root background = surface, windowInsetsPadding(safeDrawing) — STYLE_GUIDE.md §5/§6).
 * No navigation library for a four-screen skeleton; the List screen is a simple back-stack of one.
 *
 * Card B2: the Lists tab is now the real imported-list screen (import file/paste, nested list,
 * tick, persist, export) from the `list` package; the pushed detail screen is keyed by the list id.
 */
@Composable
fun ScanListApp() {
    val cs = MaterialTheme.colorScheme
    var tab by remember { mutableStateOf(Tab.Lists) }
    var openList by remember { mutableStateOf<String?>(null) }
    val listState = rememberListState()

    Column(
        Modifier
            .fillMaxSize()
            .background(cs.surface)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            val listId = openList
            when {
                listId != null -> ListDetailScreen(
                    state = listState,
                    listId = listId,
                    onBack = { openList = null },
                )
                tab == Tab.Lists -> ListsHomeScreen(listState, onOpen = { openList = it })
                tab == Tab.Scan -> ScanScreen()
                else -> SettingsScreen()
            }
        }
        TabBar(
            selected = tab,
            onSelect = { selected ->
                openList = null
                tab = selected
            },
        )
    }
}
