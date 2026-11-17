package dev.hajnina.scanlist.kotlin.scan.ui

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hajnina.scanlist.kotlin.Heavy
import dev.hajnina.scanlist.kotlin.Motion
import dev.hajnina.scanlist.kotlin.ScreenHeader
import dev.hajnina.scanlist.kotlin.SectionLabel
import dev.hajnina.scanlist.kotlin.Shapes
import dev.hajnina.scanlist.kotlin.list.FlatItem
import dev.hajnina.scanlist.kotlin.list.ListState
import dev.hajnina.scanlist.kotlin.list.flatIndex
import dev.hajnina.scanlist.kotlin.list.StoredList
import dev.hajnina.scanlist.kotlin.rank.ListEmbeddingState
import dev.hajnina.scanlist.kotlin.rank.RANK_DIMS_ACTIVE
import dev.hajnina.scanlist.kotlin.rank.defaultModelFile
import dev.hajnina.scanlist.kotlin.rank.rememberListEmbedding
import dev.hajnina.scanlist.kotlin.scan.sources.CameraScanPreview
import dev.hajnina.scanlist.kotlin.scan.sources.Clock
import dev.hajnina.scanlist.kotlin.settings.ModelProbe
import dev.hajnina.scanlist.kotlin.springIn
import dev.hajnina.scanlist.kotlin.ui.LowLightSession
import dev.hajnina.scanlist.kotlin.ui.LowLightState
import dev.hajnina.scanlist.kotlin.ui.ScanBanner
import dev.hajnina.scanlist.kotlin.ui.ScanBannerAction
import dev.hajnina.scanlist.kotlin.ui.ScanBannerKind
import dev.hajnina.scanlist.kotlin.ui.ScanBannerState
import dev.hajnina.scanlist.kotlin.ui.scanBanner
import java.util.Locale
import kotlinx.coroutines.CoroutineScope

// The magic scan (card B5): camera on top ~45 %, the ranked list below, the hero card with the big
// tick, source chips that light up as they fire, and the honest "nothing confident yet" state.
//
// The screen owns layout and haptics only. Every ranking decision comes from `RankResult.topId`
// (card B3/S10's `decideTop`); every "what is a query" decision comes from `ScanSession` (pool order,
// TTLs, sensor rotation). Styling follows references/bonsai-ui/STYLE_GUIDE.md §3–§5/§7: hero + leaf
// cards, Black display type, tonal containers carrying meaning, chips as pills, haptics on actions.
// The springy reorder is Compose's `Modifier.animateItem` with the Expressive spatial spring — the
// direct analog of the React Native card's Reanimated layout transition.

@Composable
fun ScanScreen(listState: ListState) {
    val cs = MaterialTheme.colorScheme
    val lists = listState.lists
    var selectedListId by rememberSaveable { mutableStateOf<String?>(null) }

    if (lists.isEmpty()) {
        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ScreenHeader("Magic scan", "Point at a product — the list re-sorts.", Modifier.springIn(0))
            Card(
                modifier = Modifier.fillMaxWidth().springIn(1),
                shape = Shapes.leaf,
                colors = CardDefaults.cardColors(
                    containerColor = cs.surfaceContainerHigh,
                    contentColor = cs.onSurface,
                ),
            ) {
                Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("No list to scan", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy))
                    Text(
                        "Import a list on the Lists tab first — the scan screen ranks whatever is still unticked.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = cs.onSurfaceVariant,
                    )
                }
            }
        }
        return
    }

    val stored = lists.firstOrNull { it.id == selectedListId } ?: lists.first()
    // One flat index per list version: the ranked rows and the tick use the same ids as B2's tree.
    val index = remember(stored.list) { stored.list.flatIndex() }
    // Card B3: embed/reuse the item vectors on open; the scan screen is the consumer.
    val embedding = rememberListEmbedding(LocalContext.current, stored.id, index.items)
    val vectors = embedding.vectors?.byId
    val controller = rememberScanController(
        listId = stored.id,
        items = index.items,
        vectors = vectors,
        onTick = { itemId -> listState.toggle(stored.id, itemId) },
    )
    val view = controller.view
    val haptic = LocalHapticFeedback.current
    val context = LocalContext.current

    // ---------------------------------------------------------------- card B7 state matrix
    //
    // The three environmental states the polish pass owes this screen, all decided by pure,
    // unit-tested helpers (`ui/ScanBanner`, `ui/LowLight`); this screen only holds them:
    //  - cameraGranted: reported by CameraScanPreview (null until it has looked),
    //  - modelStatus: one filesystem stat of the bundle the pipeline opens, per tab entry,
    //  - lowLight: debounced mean-luma stream from the analysed frames, scoped to the selected list
    //    so a DIM reading never survives a list switch.
    // OFF's "offline" is the barcode strip's own state (a lookup that could not reach the network).
    var cameraGranted by remember { mutableStateOf<Boolean?>(null) }
    val modelStatus = remember(context) { ModelProbe.status(defaultModelFile(context)) }
    val lowLightSession = remember { LowLightSession() }
    var lowLight by remember { mutableStateOf(LowLightState.UNKNOWN) }
    val banner = scanBanner(
        ScanBannerState(
            cameraGranted = cameraGranted,
            modelStatus = modelStatus,
            lowLight = lowLight,
            offline = controller.barcodeUi.state == OffUiState.OFFLINE,
            embedError = view.error,
        ),
    )
    // The only banner action: the permission is permanently denied (no dialog any more), so the fix
    // lives in the system app settings page.
    val openAppSettings: () -> Unit = {
        haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", context.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    // A new hero is a self-triggered state change: style guide §4 asks for a haptic on those too.
    var lastHeroId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(view.hero?.id) {
        val id = view.hero?.id
        if (id != null && id != lastHeroId) haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
        lastHeroId = id
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SectionLabel("Magic scan", Modifier.weight(1f))
            ListPicker(lists, stored.id, onSelect = { selectedListId = it })
        }

        // Camera: the top ~45 % of the screen (ARCHITECTURE.md "UI" §3).
        CameraScanPreview(
            modifier = Modifier
                .fillMaxWidth()
                .weight(0.45f)
                .clip(Shapes.hero)
                .background(cs.surfaceContainerHighest),
            onSignal = controller::onSignal,
            onPermission = { cameraGranted = it },
            onLuma = { luma ->
                val next = lowLightSession.sample(stored.id, luma)
                // Only touch Compose state when the debounced answer actually changes.
                if (next != lowLight) lowLight = next
            },
        )

        Column(
            Modifier.weight(0.55f).padding(top = 10.dp),
        ) {
            SourceStrip(view, controller.barcodeUi)
            Spacer(Modifier.height(8.dp))
            HeroSlot(
                view = view,
                embedding = embedding,
                onTick = {
                    haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    controller.tickHero()
                },
            )
            Spacer(Modifier.height(8.dp))
            RankedList(view, banner, onBannerAction = openAppSettings)
        }
    }
}

/** Wires the session/controller for one list; re-created only when the list changes. */
@Composable
private fun rememberScanController(
    listId: String,
    items: List<FlatItem>,
    vectors: Map<String, DoubleArray>?,
    onTick: (String) -> Unit,
): ScanController {
    val context = LocalContext.current
    val scope: CoroutineScope = rememberCoroutineScope()
    val itemsState = rememberUpdatedState(items)
    val vectorsState = rememberUpdatedState(vectors)
    val tickState = rememberUpdatedState(onTick)

    val controller = remember(listId) {
        val app = context.applicationContext
        val embedder = LazyQueryEmbedder(
            provider = { VectorSourceQueryEmbedder(SearchEmbedding.source(app)) },
            dims = RANK_DIMS_ACTIVE,
        )
        ScanController(
            scope = scope,
            session = ScanSession(embedder = embedder, rotator = JpegRotation),
            resolver = OffResolver(
                cache = OffCache.forFilesDir(app.filesDir),
                transport = HttpUrlConnectionTransport(),
            ),
            clock = Clock { SystemClock.elapsedRealtime() },
            items = { itemsState.value },
            vectors = { vectorsState.value },
            onTick = { id -> tickState.value(id) },
        )
    }

    LaunchedEffect(controller) { controller.start() }
    LaunchedEffect(controller, items, vectors) { controller.refresh() }
    DisposableEffect(controller) { onDispose { controller.stop() } }
    return controller
}

@Composable
private fun ListPicker(
    lists: List<StoredList>,
    selectedId: String,
    onSelect: (String) -> Unit,
) {
    if (lists.size == 1) {
        Text(
            lists.first().list.title,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        return
    }
    val haptic = LocalHapticFeedback.current
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        lists.forEach { list ->
            FilterChip(
                selected = list.id == selectedId,
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                    onSelect(list.id)
                },
                label = {
                    Text(
                        list.list.title,
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = Heavy),
                        maxLines = 1,
                    )
                },
            )
        }
    }
}

// ---------------------------------------------------------------- sources

/**
 * The three scan sources as pill chips that light up when they fire (ARCHITECTURE.md "sources shown
 * as chips"), plus the barcode's OFF story underneath. Chips are indicators, not switches: nothing
 * here can pretend to disable a source the pipeline still runs.
 */
@Composable
private fun SourceStrip(view: ScanView, barcode: BarcodeUi) {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SourcePill("BARCODE", view.chips.barcode)
            SourcePill("TEXT", view.chips.text)
            SourcePill("IMAGE", view.chips.image)
            if (!view.chips.any) {
                Text(
                    "READY",
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy, letterSpacing = 1.sp),
                    color = cs.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp, top = 8.dp),
                )
            }
        }
        val digits = barcode.barcode ?: view.barcode
        val off = barcode
        if (digits != null) {
            val line = when (off.state) {
                OffUiState.LOOKING_UP -> "OFF: looking up…"
                OffUiState.FOUND -> "OFF: ${off.text}"
                OffUiState.NO_TEXT -> "OFF: product has no name"
                OffUiState.MISS -> "OFF: not in Open Food Facts"
                OffUiState.OFFLINE -> "OFF: offline — cached text only"
                OffUiState.INVALID -> "OFF: not an EAN/UPC barcode"
                OffUiState.IDLE -> "OFF: waiting for a name"
            }
            Text(
                "$digits · $line",
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = cs.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun SourcePill(label: String, lit: Boolean) {
    val cs = MaterialTheme.colorScheme
    val container by animateColorAsState(
        targetValue = if (lit) cs.primaryContainer else cs.surfaceContainerHigh,
        animationSpec = Motion.effects(),
        label = "sourcePillContainer",
    )
    val content by animateColorAsState(
        targetValue = if (lit) cs.onPrimaryContainer else cs.onSurfaceVariant,
        animationSpec = Motion.effects(),
        label = "sourcePillContent",
    )
    val alpha by animateFloatAsState(
        targetValue = if (lit) 1f else 0.65f,
        animationSpec = Motion.effects(),
        label = "sourcePillAlpha",
    )
    Row(
        modifier = Modifier
            .graphicsLayer { this.alpha = alpha }
            .clip(RoundedCornerShape(18.dp))
            .background(container)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            if (lit) "●" else "○",
            style = MaterialTheme.typography.labelMedium,
            color = content,
        )
        Text(
            label,
            style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp),
            color = content,
        )
    }
}

// ---------------------------------------------------------------- hero

@Composable
private fun HeroSlot(view: ScanView, embedding: ListEmbeddingState, onTick: () -> Unit) {
    val hero = view.hero
    if (hero != null) {
        // key(): a new product replays the entrance spring (and the scale bump below).
        key(hero.id) { HeroCard(hero, onTick) }
        return
    }
    NoHeroCard(view, embedding)
}

@Composable
private fun HeroCard(hero: ScanHero, onTick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    // A hero that just appeared pops in at 1.08x and springs to 1 — the ZenMeter number bump, applied
    // to the card so the "found it" moment is felt as well as read (style guide §4).
    val scale = remember(hero.id) { Animatable(1.08f) }
    LaunchedEffect(hero.id) { scale.animateTo(1f, Motion.spatial()) }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale.value
                scaleY = scale.value
            }
            .springIn(1),
        shape = Shapes.hero,
        colors = CardDefaults.cardColors(
            containerColor = cs.tertiaryContainer,
            contentColor = cs.onTertiaryContainer,
        ),
    ) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp)) {
            SectionLabel(
                "Top match · ${String.format(Locale.ROOT, "%.2f", hero.score)}",
                color = cs.onTertiaryContainer.copy(alpha = 0.75f),
            )
            Text(
                hero.name,
                style = MaterialTheme.typography.headlineLarge.copy(fontWeight = Heavy),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (hero.detail.isNotEmpty()) {
                Text(hero.detail, style = MaterialTheme.typography.bodyLarge)
            }
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = onTick,
                modifier = Modifier.fillMaxWidth().height(60.dp),
                shape = RoundedCornerShape(30.dp),
            ) {
                Text(
                    "✓  TICK ITEM",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = Heavy, letterSpacing = 1.5.sp),
                )
            }
        }
    }
}

/**
 * The honest empty hero. The hero id is `decideTop`'s output and is null more often than not; the UI
 * must never invent a match, so this card says what is missing and what would help.
 */
@Composable
private fun NoHeroCard(view: ScanView, embedding: ListEmbeddingState) {
    val cs = MaterialTheme.colorScheme
    val container = when (view.status) {
        ScanStatus.NO_VECTORS -> cs.secondaryContainer
        ScanStatus.LIST_EMPTY -> cs.surfaceContainerHigh
        else -> cs.surfaceContainerHigh
    }
    val content = when (view.status) {
        ScanStatus.NO_VECTORS -> cs.onSecondaryContainer
        else -> cs.onSurface
    }
    val label = when (view.status) {
        ScanStatus.LIST_EMPTY -> "List complete"
        ScanStatus.NO_VECTORS -> "Ranking off"
        ScanStatus.NO_SIGNAL -> "Scanning"
        ScanStatus.TICKED -> "Ticked"
        else -> "No confident match"
    }
    val message = view.message ?: "Point the camera at a product."
    val progress = embedding.progress
    Card(
        modifier = Modifier.fillMaxWidth().springIn(1),
        shape = Shapes.leaf,
        colors = CardDefaults.cardColors(containerColor = container, contentColor = content),
    ) {
        Column(Modifier.padding(horizontal = 22.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            SectionLabel(label, color = content.copy(alpha = 0.75f))
            Text(message, style = MaterialTheme.typography.bodyLarge)
            if (view.status == ScanStatus.NO_VECTORS && progress.total > 0 && !progress.complete) {
                Text(
                    "Embedding items… ${progress.done}/${progress.total}",
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = content.copy(alpha = 0.75f),
                )
            }
            view.error?.let { error ->
                Text(
                    error,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = content.copy(alpha = 0.8f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ---------------------------------------------------------------- ranked rows

@Composable
private fun RankedList(view: ScanView, banner: ScanBanner?, onBannerAction: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Card B7: the degraded-state banner rides at the top of the scrollable list, so a small
        // screen is never squeezed (the camera 45 % / list 55 % split is fixed by B5).
        banner?.let { current ->
            item(key = "banner") { ScanBannerCard(current, onBannerAction) }
        }
        items(view.rows, key = { it.id }) { row ->
            RankRow(row, leftFirst = true, modifier = Modifier.animateItem(placementSpec = Motion.spatial()))
        }
        if (view.done.isNotEmpty()) {
            item(key = "done-label") {
                SectionLabel(
                    "Done · ${view.done.size}",
                    Modifier.padding(start = 8.dp, top = 6.dp),
                )
            }
            items(view.done, key = { "done-${it.id}" }) { row ->
                RankRow(row, leftFirst = false, modifier = Modifier.animateItem(placementSpec = Motion.spatial()))
            }
        }
        item(key = "off-credit") {
            Text(
                "Product data: Open Food Facts (ODbL 1.0)",
                style = MaterialTheme.typography.bodySmall,
                color = cs.onSurfaceVariant.copy(alpha = 0.8f),
                modifier = Modifier.padding(start = 8.dp, top = 4.dp, bottom = 12.dp),
            )
        }
    }
}

/**
 * Card B7 — one tonal banner for the scan screen's degraded states. The colour *is* the message, in
 * the style guide's vocabulary (§3): errorContainer for a missing model/embedder, tertiaryContainer
 * for advice (low light), secondaryContainer for the informational offline note, and the neutral
 * surfaceContainerHigh for a permission that is simply off.
 */
@Composable
private fun ScanBannerCard(banner: ScanBanner, onAction: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val container = when (banner.kind) {
        ScanBannerKind.CAMERA -> cs.surfaceContainerHigh
        ScanBannerKind.MODEL, ScanBannerKind.EMBED -> cs.errorContainer
        ScanBannerKind.LOW_LIGHT -> cs.tertiaryContainer
        ScanBannerKind.OFFLINE -> cs.secondaryContainer
    }
    val content = when (banner.kind) {
        ScanBannerKind.CAMERA -> cs.onSurface
        ScanBannerKind.MODEL, ScanBannerKind.EMBED -> cs.onErrorContainer
        ScanBannerKind.LOW_LIGHT -> cs.onTertiaryContainer
        ScanBannerKind.OFFLINE -> cs.onSecondaryContainer
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = Shapes.leafMirror,
        colors = CardDefaults.cardColors(containerColor = container, contentColor = content),
    ) {
        Column(
            Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            SectionLabel(banner.title, color = content.copy(alpha = 0.75f))
            Text(banner.body, style = MaterialTheme.typography.bodySmall, color = content)
            if (banner.action == ScanBannerAction.OPEN_SETTINGS) {
                TextButton(onClick = onAction) {
                    Text(
                        "APP SETTINGS",
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp),
                    )
                }
            }
        }
    }
}

@Composable
private fun RankRow(row: ScanRow, leftFirst: Boolean, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = Shapes.tile(leftFirst = leftFirst),
        colors = CardDefaults.cardColors(
            containerColor = if (row.done) cs.surfaceContainer else cs.surfaceContainerHigh,
            contentColor = if (row.done) cs.onSurfaceVariant else cs.onSurface,
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    row.name,
                    style = MaterialTheme.typography.titleLarge.copy(
                        fontWeight = Heavy,
                        textDecoration = if (row.done) TextDecoration.LineThrough else null,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (row.detail.isNotEmpty()) {
                    Text(
                        row.detail,
                        style = MaterialTheme.typography.bodyMedium,
                        color = cs.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (row.done) {
                Text("✓", style = MaterialTheme.typography.titleLarge.copy(fontWeight = Heavy), color = cs.primary)
            } else if (row.score != null) {
                Text(
                    String.format(Locale.ROOT, "%.2f", row.score),
                    style = MaterialTheme.typography.titleMedium,
                    fontFamily = FontFamily.Monospace,
                    color = cs.onSurfaceVariant,
                )
            }
        }
    }
}
