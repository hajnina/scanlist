package dev.hajnina.scanlist.kotlin

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The last remaining B1 stub screen (Scan). Cards B5/B6 replace them; card B6 moved Settings out of
// this file into the `settings` package (SettingsScreen.kt: backend picker, live embed latency, model
// status/path, prefix set) and App.kt now imports it — the only files this card touched outside its
// `owns:` directory. The stub used the same expressive styling as the rest of B1.
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
