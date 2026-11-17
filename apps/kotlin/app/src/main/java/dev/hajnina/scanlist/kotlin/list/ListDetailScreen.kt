package dev.hajnina.scanlist.kotlin.list

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hajnina.scanlist.kotlin.Heavy
import dev.hajnina.scanlist.kotlin.Motion
import dev.hajnina.scanlist.kotlin.Pressable
import dev.hajnina.scanlist.kotlin.ScreenHeader
import dev.hajnina.scanlist.kotlin.SectionLabel
import dev.hajnina.scanlist.kotlin.Shapes
import dev.hajnina.scanlist.kotlin.springIn

// List screen of card B2: the nested, collapsible sections of the imported JSON, tick/untick with
// haptics, progress, and export of the same JSON (share sheet / save to a file / copy).
// The tree is rendered exactly as imported — section order, item order, any depth (LIST.md §2) —
// which is the unranked view RANK.md §7 calls for when no scan is running.
// Visual language copied from B1's stub ListScreen (style guide §3-§5).

@Composable
fun ListDetailScreen(state: ListState, listId: String, onBack: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val context = LocalContext.current
    val stored = state.get(listId)

    if (stored == null) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onBack) { Text("‹ LISTS") }
            ScreenHeader("List gone", "It was deleted or could not be read.")
        }
        return
    }

    val list = stored.list
    // One id map per list version: the UI ticks by the same ids the flattener produced.
    val index = remember(list) { list.flatIndex() }
    val total = index.items.size
    val left = index.items.count { !it.done }
    val progress by animateFloatAsState(
        targetValue = if (total == 0) 0f else (total - left).toFloat() / total,
        animationSpec = Motion.slowEffects(),
        label = "listProgress",
    )

    val saveLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument(ListTransfer.MIME_JSON),
    ) { uri ->
        if (uri != null) {
            val json = state.exportJson(listId)
            if (json == null) {
                state.say("Nothing to export")
            } else {
                ListTransfer.write(context, uri, json)
                    .onSuccess {
                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                        state.say("Saved ${ListTransfer.fileNameFor(list.title)}")
                    }
                    .onFailure { state.say("Save failed: ${it.message}") }
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.ToggleOff)
                onBack()
            },
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp),
        ) {
            Text("‹ LISTS", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp))
        }

        ScreenHeader(
            list.title,
            if (total == 0) "Empty list" else "$left left · $total items · JSON v${list.version}",
            Modifier.springIn(0),
        )

        // Hero: items left + the 14 dp round-capped progress bar (STYLE_GUIDE §3).
        Card(
            modifier = Modifier.fillMaxWidth().springIn(1),
            shape = Shapes.hero,
            colors = CardDefaults.cardColors(
                containerColor = if (left == 0) cs.tertiaryContainer else cs.primaryContainer,
                contentColor = if (left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer,
            ),
        ) {
            Column(Modifier.padding(28.dp)) {
                SectionLabel(
                    if (left == 0) "Done" else "To go",
                    color = (if (left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer).copy(alpha = 0.75f),
                )
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        "$left",
                        style = MaterialTheme.typography.displayLarge.copy(fontWeight = Heavy, fontSize = 72.sp),
                    )
                    Text(
                        " ITEMS LEFT",
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = Heavy),
                        modifier = Modifier.padding(start = 6.dp, bottom = 12.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
                ListProgress(
                    progress = progress,
                    containerColor = if (left == 0) cs.tertiary else cs.primary,
                    trackColor = (if (left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer).copy(alpha = 0.15f),
                )
            }
        }

        if (total == 0) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = Shapes.leaf,
                colors = CardDefaults.cardColors(
                    containerColor = cs.surfaceContainerHigh,
                    contentColor = cs.onSurface,
                ),
            ) {
                Column(Modifier.padding(24.dp)) {
                    Text("Nothing to buy", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy))
                    Text(
                        "\"sections\": [] is a valid list — import another file to fill it.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }

        list.sections.forEachIndexed { sectionIndex, section ->
            SectionBlock(
                section = section,
                sectionPath = listOf(sectionIndex),
                depth = 0,
                index = index,
                state = state,
                listId = listId,
                animationIndex = 2 + sectionIndex,
            )
        }

        // Export: the same JSON shape back, with done flags (LIST.md §7).
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = Shapes.leafMirror,
            colors = CardDefaults.cardColors(
                containerColor = cs.secondaryContainer,
                contentColor = cs.onSecondaryContainer,
            ),
        ) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("Export", color = cs.onSecondaryContainer.copy(alpha = 0.75f))
                Text(
                    "Same nested JSON with \"done\": true on ticked items — importable anywhere.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ExportButton("SHARE", Modifier.weight(1f)) {
                        val json = state.exportJson(listId)
                        if (json == null) {
                            state.say("Nothing to export")
                        } else {
                            haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                            ListTransfer.share(context, json, list.title)
                        }
                    }
                    ExportButton("SAVE", Modifier.weight(1f)) {
                        haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                        saveLauncher.launch(ListTransfer.fileNameFor(list.title))
                    }
                    ExportButton("COPY", Modifier.weight(1f)) {
                        val json = state.exportJson(listId)
                        if (json != null) {
                            ListTransfer.copy(context, json)
                            haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                            state.say("Copied the JSON to the clipboard")
                        }
                    }
                }
                Text(
                    "stored at filesDir/lists/${stored.id}.json",
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = cs.onSecondaryContainer.copy(alpha = 0.7f),
                )
            }
        }

        state.note?.let { note ->
            NoteCard(note, onDismiss = { state.clearNote() })
        }

        Spacer(Modifier.height(4.dp))
    }
}

@Composable
private fun ExportButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier, contentPadding = androidx.compose.foundation.layout.PaddingValues(8.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp))
    }
}

/**
 * One section: a tappable header (collapsible, open by default at the top level) with the item rows
 * of this section first and then its sub-sections, exactly the FLATTEN.md §2 order.
 */
@Composable
private fun SectionBlock(
    section: ListSection,
    sectionPath: List<Int>,
    depth: Int,
    index: FlatIndex,
    state: ListState,
    listId: String,
    animationIndex: Int,
) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val pathKey = remember(sectionPath) { sectionPath.joinToString(".") }
    var open by rememberSaveable(pathKey) { mutableStateOf(depth == 0) }

    val done = section.doneItems()
    val total = section.totalItems()

    Column(
        Modifier.fillMaxWidth().padding(start = (depth * 10).dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Pressable(
                onClick = {
                    open = !open
                    haptic.performHapticFeedback(
                        if (open) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff,
                    )
                },
                shape = RoundedCornerShape(if (open) 28.dp else 18.dp),
                containerColor = if (open) cs.surfaceContainerHigh else cs.surfaceContainer,
                contentColor = cs.onSurface,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            section.name,
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = Heavy),
                        )
                        Text(
                            if (total == 0) "no items" else "$done of $total ticked",
                            style = MaterialTheme.typography.bodySmall,
                            color = cs.onSurfaceVariant,
                        )
                    }
                    Text(
                        if (open) "▾" else "▸",
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = Heavy),
                        color = cs.onSurfaceVariant,
                    )
                }
        }

        AnimatedVisibility(visible = open) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                section.items.forEachIndexed { itemIndex, item ->
                    val itemId = index.idAt(sectionPath, itemIndex) ?: return@forEachIndexed
                    ItemRow(
                        item = item,
                        depth = depth,
                        animationIndex = animationIndex + itemIndex,
                        onToggle = {
                            haptic.performHapticFeedback(
                                if (item.done) HapticFeedbackType.ToggleOff else HapticFeedbackType.Confirm,
                            )
                            state.toggle(listId, itemId)
                        },
                    )
                }
                section.sections.forEachIndexed { childIndex, child ->
                    SectionBlock(
                        section = child,
                        sectionPath = sectionPath + childIndex,
                        depth = depth + 1,
                        index = index,
                        state = state,
                        listId = listId,
                        animationIndex = animationIndex + childIndex + 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun ItemRow(item: ListItem, depth: Int, animationIndex: Int, onToggle: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val done = item.done

    // Checked items sink into surfaceContainerHigh and their corner morphs 44 -> 28 dp (B1 pattern).
    val corner by animateDpAsState(
        targetValue = if (done) 28.dp else 44.dp,
        animationSpec = Motion.spatial(),
        label = "itemCorner",
    )
    val background by animateColorAsState(
        targetValue = if (done) cs.surfaceContainerHigh else cs.surfaceContainer,
        animationSpec = Motion.effects(),
        label = "itemBackground",
    )
    val foreground by animateColorAsState(
        targetValue = if (done) cs.onSurfaceVariant else cs.onSurface,
        animationSpec = Motion.effects(),
        label = "itemForeground",
    )

    Pressable(
        onClick = onToggle,
        shape = RoundedCornerShape(corner),
        containerColor = background,
        contentColor = foreground,
        modifier = Modifier.fillMaxWidth().springIn(animationIndex.coerceAtMost(7) + 2),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 22.dp + (depth * 10).dp, end = 22.dp, top = 16.dp, bottom = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    item.displayName(),
                    style = MaterialTheme.typography.headlineSmall.copy(
                        fontWeight = Heavy,
                        textDecoration = if (done) TextDecoration.LineThrough else null,
                    ),
                )
                val amount = item.displayText()
                if (amount.isNotEmpty()) {
                    Text(
                        amount,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (done) cs.onSurfaceVariant else cs.onSurface,
                    )
                }
                item.displayNote()?.let { note ->
                    Text(
                        note,
                        style = MaterialTheme.typography.bodySmall,
                        color = cs.onSurfaceVariant,
                    )
                }
            }
            Text(
                if (done) "✓" else "○",
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy),
                color = if (done) cs.primary else cs.onSurfaceVariant,
            )
        }
    }
}
