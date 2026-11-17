package dev.hajnina.scanlist.kotlin.list

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hajnina.scanlist.kotlin.Heavy
import dev.hajnina.scanlist.kotlin.Motion
import dev.hajnina.scanlist.kotlin.Pressable
import dev.hajnina.scanlist.kotlin.ScreenHeader
import dev.hajnina.scanlist.kotlin.SectionLabel
import dev.hajnina.scanlist.kotlin.Shapes
import dev.hajnina.scanlist.kotlin.springIn

// Lists screen of card B2: import (SAF file picker / paste) + the stored lists, each opening the
// nested list screen. Same visual language as B1 (style guide §3-§5): hero card, alternating leaf
// cards, Black display type, 14 dp round-capped progress bar, haptics on every action.
// Copied structure from apps/kotlin/.../Screens.kt (B1 stub) and references/bonsai-ui/STYLE_GUIDE.md.

@Composable
fun ListsHomeScreen(state: ListState, onOpen: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val (total, ticked) = state.totals()
    val left = total - ticked
    val progress by animateFloatAsState(
        targetValue = if (total == 0) 0f else ticked.toFloat() / total,
        animationSpec = Motion.slowEffects(),
        label = "listsProgress",
    )

    // A fresh import jumps straight into the new list, like a file picker would in a notes app.
    LaunchedEffect(state.lastImported?.id) {
        state.lastImported?.let { imported ->
            state.consumeLastImported()
            onOpen(imported.id)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ScreenHeader("Shopping list", "Import, tick, export.", Modifier.springIn(0))

        // Hero: the exported format is plain JSON, so the count is the whole state of the app.
        Card(
            modifier = Modifier.fillMaxWidth().springIn(1),
            shape = Shapes.hero,
            colors = CardDefaults.cardColors(
                containerColor = if (total > 0 && left == 0) cs.tertiaryContainer else cs.primaryContainer,
                contentColor = if (total > 0 && left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer,
            ),
        ) {
            Column(Modifier.padding(28.dp)) {
                SectionLabel(
                    if (total == 0) "Nothing imported" else if (left == 0) "All done" else "To go",
                    color = (if (total > 0 && left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer)
                        .copy(alpha = 0.75f),
                )
                Text(
                    if (total == 0) "0" else "$left",
                    style = MaterialTheme.typography.displayLarge.copy(fontWeight = Heavy, fontSize = 56.sp),
                )
                Text(
                    when {
                        total == 0 -> "Pick a .json file or paste one to start."
                        state.lists.size == 1 -> "$total items · $ticked ticked"
                        else -> "$total items in ${state.lists.size} lists · $ticked ticked"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(10.dp))
                ListProgress(
                    progress = progress,
                    containerColor = if (total > 0 && left == 0) cs.tertiary else cs.primary,
                    trackColor = (if (total > 0 && left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer)
                        .copy(alpha = 0.15f),
                )
            }
        }

        ImportActions(state, Modifier.springIn(2))

        state.note?.let { note ->
            NoteCard(note, onDismiss = { state.clearNote() })
        }

        if (state.lists.isNotEmpty()) {
            SectionLabel("Lists", Modifier.padding(start = 8.dp, top = 4.dp))
        }

        state.lists.forEachIndexed { index, stored ->
            val flat = stored.list.flatten()
            val listLeft = flat.count { !it.done }
            val listProgress by animateFloatAsState(
                targetValue = if (flat.isEmpty()) 0f else (flat.size - listLeft).toFloat() / flat.size,
                animationSpec = Motion.slowEffects(),
                label = "listProgress${stored.id}",
            )
            Pressable(
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    onOpen(stored.id)
                },
                // Alternating asymmetric "leaf" cards, Bonsai's checkerboard rhythm.
                shape = if (index % 2 == 0) Shapes.leaf else Shapes.leafMirror,
                containerColor = if (index % 2 == 0) cs.secondaryContainer else cs.surfaceContainerHigh,
                contentColor = if (index % 2 == 0) cs.onSecondaryContainer else cs.onSurface,
                modifier = Modifier.fillMaxWidth().springIn(3 + index),
            ) {
                Column(Modifier.padding(24.dp)) {
                    Text(
                        stored.list.title,
                        style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy),
                    )
                    Text(
                        if (flat.isEmpty()) "empty list" else "$listLeft left · ${flat.size} items",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (flat.isNotEmpty()) {
                        Spacer(Modifier.height(10.dp))
                        ListProgress(
                            progress = listProgress,
                            containerColor = if (index % 2 == 0) cs.secondary else cs.primary,
                            trackColor = (if (index % 2 == 0) cs.onSecondaryContainer else cs.onSurface)
                                .copy(alpha = 0.15f),
                        )
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(
                            onClick = {
                                haptic.performHapticFeedback(HapticFeedbackType.ToggleOff)
                                state.delete(stored.id)
                            },
                        ) {
                            Text(
                                "DELETE",
                                style = MaterialTheme.typography.labelLarge.copy(
                                    fontWeight = Heavy,
                                    letterSpacing = 1.sp,
                                ),
                            )
                        }
                    }
                }
            }
        }

        if (total > 0) {
            Column(Modifier.padding(start = 8.dp, top = 4.dp)) {
                SectionLabel("Format")
                Text(
                    "shared/spec/LIST.md v1 — title, sections, items (amount number|string, unit, note, aliases, done)",
                    style = MaterialTheme.typography.bodySmall,
                    color = cs.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(4.dp))
    }
}
