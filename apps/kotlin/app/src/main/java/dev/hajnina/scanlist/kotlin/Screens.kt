package dev.hajnina.scanlist.kotlin

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The two remaining B1 stub screens (Scan, Settings). Cards B5/B6 replace them.
// Styling follows references/bonsai-ui/STYLE_GUIDE.md §3–§5/§7: hero + leaf cards, Black display
// type, 14dp round-capped progress bars, tonal containers carrying meaning, haptics on every action.
//
// Card B2 moved the Lists and List screens out of this file into the `list` package
// (ListsHomeScreen.kt / ListDetailScreen.kt) together with the real imported-list data, per the B1
// review nit "split screens into per-feature files as you touch them" — no other screen touched.

// ---------------------------------------------------------------- Scan

private data class Ranked(val name: String, val score: Float, val section: String)

@Composable
fun ScanScreen() {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    var sources by remember { mutableStateOf(setOf("BARCODE")) }
    val ranked = listOf(
        Ranked("Sourdough", 0.61f, "Bakery"),
        Ranked("Olive oil", 0.48f, "Pantry"),
        Ranked("Basil", 0.41f, "Produce"),
    )

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ScreenHeader("Magic scan", "Point at a product — the list re-sorts.", Modifier.springIn(0))

        // Camera placeholder (preview occupies the top of this screen for real later).
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(210.dp)
                .springIn(1)
                .clip(Shapes.hero)
                .background(cs.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    "◎",
                    style = MaterialTheme.typography.displayLarge.copy(fontWeight = Heavy),
                    color = cs.onSurfaceVariant,
                )
                Text(
                    "Camera preview lands with the camera card",
                    style = MaterialTheme.typography.bodyMedium,
                    color = cs.onSurfaceVariant,
                )
            }
        }

        // Scan sources as chips that light up when they fire (barcode / OCR / image embed).
        Row(
            modifier = Modifier.springIn(2).horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("BARCODE", "TEXT", "IMAGE").forEach { source ->
                FilterChip(
                    selected = source in sources,
                    onClick = {
                        sources = if (source in sources) sources - source else sources + source
                        haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                    },
                    label = {
                        Text(
                            source,
                            style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp),
                        )
                    },
                )
            }
        }

        SectionLabel("Top match · 0.83", Modifier.padding(start = 8.dp, top = 4.dp))

        Card(
            modifier = Modifier.fillMaxWidth().springIn(3),
            shape = Shapes.leaf,
            colors = CardDefaults.cardColors(
                containerColor = cs.tertiaryContainer,
                contentColor = cs.onTertiaryContainer,
            ),
        ) {
            Column(Modifier.padding(28.dp)) {
                Text(
                    "Cherry tomatoes",
                    style = MaterialTheme.typography.headlineLarge.copy(fontWeight = Heavy),
                )
                Text("250 g · Produce · matched by IMAGE", style = MaterialTheme.typography.bodyLarge)
                Spacer(Modifier.height(14.dp))
                Button(
                    onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "TICK ITEM",
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp),
                    )
                }
            }
        }

        SectionLabel("Next in line", Modifier.padding(start = 8.dp, top = 4.dp))

        ranked.forEachIndexed { index, item ->
            Card(
                modifier = Modifier.fillMaxWidth().springIn(4 + index),
                shape = Shapes.tile(leftFirst = index % 2 == 0),
                colors = CardDefaults.cardColors(
                    containerColor = cs.surfaceContainerHigh,
                    contentColor = cs.onSurface,
                ),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(item.name, style = MaterialTheme.typography.titleLarge.copy(fontWeight = Heavy))
                        Text(item.section, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(
                        "%.2f".format(item.score),
                        style = MaterialTheme.typography.titleMedium,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }

        Spacer(Modifier.height(4.dp))
    }
}

// ---------------------------------------------------------------- Settings

@Composable
fun SettingsScreen() {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    var backend by remember { mutableStateOf("AUTO") }
    var liveRanking by remember { mutableStateOf(true) }

    // Big toggle surface: corner 64 <-> 28 dp, colour crossfade, like Bonsai's kill switch.
    val toggleCorner by animateDpAsState(
        targetValue = if (liveRanking) 64.dp else 28.dp,
        animationSpec = Motion.spatial(),
        label = "liveCorner",
    )
    val toggleBackground by animateColorAsState(
        targetValue = if (liveRanking) cs.primary else cs.surfaceContainerHigh,
        animationSpec = Motion.effects(),
        label = "liveBackground",
    )
    val toggleForeground by animateColorAsState(
        targetValue = if (liveRanking) cs.onPrimary else cs.onSurface,
        animationSpec = Motion.effects(),
        label = "liveForeground",
    )

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ScreenHeader("Settings", "Backends, model, scanner.", Modifier.springIn(0))

        Card(
            modifier = Modifier.fillMaxWidth().springIn(1),
            shape = Shapes.leaf,
            colors = CardDefaults.cardColors(
                containerColor = cs.surfaceContainerHigh,
                contentColor = cs.onSurface,
            ),
        ) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("Embedding backend")
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf("AUTO", "NPU", "GPU", "CPU", "SERVER").forEach { option ->
                        FilterChip(
                            selected = backend == option,
                            onClick = {
                                backend = option
                                haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                            },
                            label = { Text(option) },
                        )
                    }
                }
                Text(
                    "Live latency appears when shared/android-embed (card S5) lands; this picker is a stub.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = cs.onSurfaceVariant,
                )
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth().springIn(2),
            shape = Shapes.hero,
            colors = CardDefaults.cardColors(
                containerColor = cs.primaryContainer,
                contentColor = cs.onPrimaryContainer,
            ),
        ) {
            Column(Modifier.padding(28.dp)) {
                SectionLabel("Model", color = cs.onPrimaryContainer.copy(alpha = 0.75f))
                Text(
                    "EmbeddingGemma 2",
                    style = MaterialTheme.typography.displaySmall.copy(fontWeight = Heavy),
                )
                Text(
                    "Text + image in one 768-d space, Matryoshka to 256.",
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "embeddinggemma-2-740m.litertlm · 484,622,336 B",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }

        Pressable(
            onClick = {
                liveRanking = !liveRanking
                haptic.performHapticFeedback(
                    if (liveRanking) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff,
                )
            },
            shape = RoundedCornerShape(toggleCorner),
            containerColor = toggleBackground,
            contentColor = toggleForeground,
            modifier = Modifier.fillMaxWidth().springIn(3),
        ) {
            Row(
                Modifier.padding(horizontal = 28.dp, vertical = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Live ranking",
                        style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy),
                    )
                    Text(
                        if (liveRanking) "Re-rank every 400 ms, EMA-smoothed" else "Paused: list stays in JSON order",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Switch(
                    checked = liveRanking,
                    onCheckedChange = null,
                    modifier = Modifier
                        .padding(start = 16.dp)
                        .graphicsLayer {
                            scaleX = 1.3f
                            scaleY = 1.3f
                        },
                    thumbContent = {
                        Text(
                            if (liveRanking) "✓" else "✕",
                            fontSize = 12.sp,
                            fontWeight = Heavy,
                        )
                    },
                )
            }
        }

        Column(Modifier.springIn(4).padding(start = 8.dp, top = 4.dp)) {
            SectionLabel("About")
            Text(
                "dev.hajnina.scanlist.kotlin · 0.1.0 (B1 skeleton)",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = cs.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(4.dp))
    }
}
