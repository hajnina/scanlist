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
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The four stubbed screens of card B1 (Lists, List, Scan, Settings). Styling follows
// references/bonsai-ui/STYLE_GUIDE.md §3–§5/§7: hero + leaf cards, Black display type, 14dp
// round-capped progress bars, tonal containers carrying meaning, haptics on every action.
// Data is deliberately local stub data — the JSON parser/ranker cards replace it later.

data class StubItem(val name: String, val amount: String, val section: String, val done: Boolean = false)

data class StubList(val name: String, val place: String, val items: List<StubItem>)

private data class Ranked(val name: String, val score: Float, val section: String)

private val stubLists = listOf(
    StubList(
        name = "Weekly shop",
        place = "REWE · sat",
        items = listOf(
            StubItem("Whole milk", "2 l", "Dairy"),
            StubItem("Sourdough", "1 loaf", "Bakery"),
            StubItem("Cherry tomatoes", "250 g", "Produce"),
            StubItem("Greek yoghurt", "500 g", "Dairy", done = true),
            StubItem("Olive oil", "1 bottle", "Pantry"),
            StubItem("Basil", "1 pot", "Produce"),
        ),
    ),
    StubList(
        name = "Hardware run",
        place = "Hornbach · sun",
        items = listOf(
            StubItem("Wood screws 4x40", "100 pc", "Fasteners"),
            StubItem("Wall plugs", "50 pc", "Fasteners"),
            StubItem("Sanding paper 120", "5 sheets", "Finishing"),
            StubItem("Wood glue", "1 bottle", "Adhesives", done = true),
        ),
    ),
    StubList(
        name = "Pharmacy",
        place = "Apotheke · mon",
        items = listOf(
            StubItem("Ibuprofen 400", "20 pc", "Pain"),
            StubItem("Plasters", "1 box", "First aid"),
        ),
    ),
)

// ---------------------------------------------------------------- Lists

@Composable
fun ListsScreen(onOpen: (StubList) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val lists = stubLists

    val total = lists.sumOf { it.items.size }
    val left = lists.sumOf { list -> list.items.count { item -> !item.done } }
    val progress by animateFloatAsState(
        targetValue = if (total == 0) 0f else (total - left).toFloat() / total,
        animationSpec = Motion.slowEffects(),
        label = "listsProgress",
    )

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ScreenHeader("Shopping list", "Scan it, tick it, done.", Modifier.springIn(0))

        // Hero card: how much is left across every list (primaryContainer = main state).
        Card(
            modifier = Modifier.fillMaxWidth().springIn(1),
            shape = Shapes.hero,
            colors = CardDefaults.cardColors(
                containerColor = cs.primaryContainer,
                contentColor = cs.onPrimaryContainer,
            ),
        ) {
            Column(Modifier.padding(28.dp)) {
                SectionLabel("This week", color = cs.onPrimaryContainer.copy(alpha = 0.75f))
                Text(
                    "$left LEFT",
                    style = MaterialTheme.typography.displayLarge.copy(fontWeight = Heavy, fontSize = 56.sp),
                )
                Text(
                    "$total items in ${lists.size} lists · ${total - left} ticked",
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(10.dp))
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.fillMaxWidth().height(14.dp),
                    color = cs.primary,
                    trackColor = cs.onPrimaryContainer.copy(alpha = 0.15f),
                    strokeCap = StrokeCap.Round,
                    gapSize = 0.dp,
                    drawStopIndicator = {},
                )
            }
        }

        SectionLabel("Lists", Modifier.padding(start = 8.dp, top = 4.dp))

        lists.forEachIndexed { index, list ->
            val itemsLeft = list.items.count { item -> !item.done }
            Pressable(
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    onOpen(list)
                },
                // Alternating asymmetric "leaf" cards, Bonsai's checkerboard rhythm.
                shape = if (index % 2 == 0) Shapes.leaf else Shapes.leafMirror,
                containerColor = if (index % 2 == 0) cs.secondaryContainer else cs.surfaceContainerHigh,
                contentColor = if (index % 2 == 0) cs.onSecondaryContainer else cs.onSurface,
                modifier = Modifier.fillMaxWidth().springIn(2 + index),
            ) {
                Column(Modifier.padding(24.dp)) {
                    Text(
                        list.name,
                        style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy),
                    )
                    Text(
                        "$itemsLeft left · ${list.items.size} items · ${list.place}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }

        Spacer(Modifier.height(4.dp))
    }
}

// ---------------------------------------------------------------- List

@Composable
fun ListScreen(list: StubList, onBack: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val checked = remember(list) {
        mutableStateListOf<Boolean>().apply { addAll(list.items.map { it.done }) }
    }
    val total = list.items.size
    val left = checked.count { !it }
    val progress by animateFloatAsState(
        targetValue = if (total == 0) 0f else (total - left).toFloat() / total,
        animationSpec = Motion.slowEffects(),
        label = "listProgress",
    )

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.ToggleOff)
                onBack()
            },
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
        ) {
            Text("‹ LISTS", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp))
        }

        ScreenHeader(list.name, list.place, Modifier.springIn(0))

        // Hero: N LEFT + the 14dp round-capped progress bar from the style guide.
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
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.fillMaxWidth().height(14.dp),
                    color = if (left == 0) cs.tertiary else cs.primary,
                    trackColor = (if (left == 0) cs.onTertiaryContainer else cs.onPrimaryContainer).copy(alpha = 0.15f),
                    strokeCap = StrokeCap.Round,
                    gapSize = 0.dp,
                    drawStopIndicator = {},
                )
            }
        }

        // Nested sections stay in JSON order (STYLE_GUIDE §7: fallback = sections intact).
        var lastSection: String? = null
        list.items.forEachIndexed { index, item ->
            if (item.section != lastSection) {
                lastSection = item.section
                SectionLabel(item.section, Modifier.padding(start = 8.dp, top = 4.dp))
            }
            ItemRow(
                item = item,
                done = checked[index],
                index = index,
                onToggle = {
                    val nowChecked = !checked[index]
                    checked[index] = nowChecked
                    haptic.performHapticFeedback(
                        if (nowChecked) HapticFeedbackType.Confirm else HapticFeedbackType.ToggleOff,
                    )
                },
            )
        }

        if (left == 0) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = Shapes.leafMirror,
                colors = CardDefaults.cardColors(
                    containerColor = cs.tertiaryContainer,
                    contentColor = cs.onTertiaryContainer,
                ),
            ) {
                Column(Modifier.padding(24.dp)) {
                    Text("All ticked", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy))
                    Text(
                        "Export writes the same nested JSON back with done: true.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }

        Spacer(Modifier.height(4.dp))
    }
}

@Composable
private fun ItemRow(item: StubItem, done: Boolean, index: Int, onToggle: () -> Unit) {
    val cs = MaterialTheme.colorScheme

    // Checked items sink into surfaceContainerHigh and their corner morphs 44 -> 28 dp.
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
        modifier = Modifier.fillMaxWidth().springIn(index.coerceAtMost(7) + 2),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    item.name,
                    style = MaterialTheme.typography.headlineSmall.copy(
                        fontWeight = Heavy,
                        textDecoration = if (done) TextDecoration.LineThrough else null,
                    ),
                )
                Text("${item.amount} · ${item.section}", style = MaterialTheme.typography.bodyMedium)
            }
            Text(
                if (done) "✓" else "○",
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy),
                color = if (done) cs.primary else cs.onSurfaceVariant,
            )
        }
    }
}

// ---------------------------------------------------------------- Scan

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
