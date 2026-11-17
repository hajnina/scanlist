package dev.hajnina.scanlist.kotlin.settings

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hajnina.scanlist.kotlin.Heavy
import dev.hajnina.scanlist.kotlin.Motion
import dev.hajnina.scanlist.kotlin.Pressable
import dev.hajnina.scanlist.kotlin.ScreenHeader
import dev.hajnina.scanlist.kotlin.SectionLabel
import dev.hajnina.scanlist.kotlin.Shapes
import dev.hajnina.scanlist.kotlin.springIn

/**
 * Card B6 — the real Settings screen (the B1 stub in `Screens.kt` is gone):
 *
 *  1. backend picker Auto / GPU / CPU / NPU (experimental), persisted across restarts;
 *  2. live embed latency: switching a backend re-embeds three fixed samples on the new backend and
 *     shows per-call + mean latency plus the engine load time;
 *  3. model file status and the exact path the pipeline reads, with E_NO_MODEL when it is missing;
 *  4. the active prefix set and its doc/query prefixes, read from the bundled prompts.json.
 *
 * Styling follows references/bonsai-ui/STYLE_GUIDE.md §3–§5/§7 the same way the B1 stub and B2's list
 * screens do. The screen is deliberately thin: every decision is in BackendChoice / SettingsStore /
 * ModelProbe / PrefixInfo / SelfTestRunner and covered by JVM unit tests.
 */
@Composable
fun SettingsScreen() {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val state = rememberSettingsState()

    // Done-when: a backend switch (or "test again") re-embeds and shows the new numbers.
    LaunchedEffect(state.choice, state.runToken) { state.run() }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ScreenHeader("Settings", "Backends, model, scanner.", Modifier.springIn(0))
        BackendCard(state)
        LatencyCard(state)
        ModelCard(state)
        PrefixCard(state)
        LiveRankingCard(haptics = haptic)
        AboutSection()
        Spacer(Modifier.height(4.dp))
    }
}

// ---------------------------------------------------------------- backend picker

@Composable
private fun BackendCard(state: SettingsState) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current

    Card(
        modifier = Modifier.fillMaxWidth().springIn(1),
        shape = Shapes.leaf,
        colors = CardDefaults.cardColors(containerColor = cs.surfaceContainerHigh, contentColor = cs.onSurface),
    ) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel("Embedding backend")
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                BackendChoice.entries.forEach { option ->
                    FilterChip(
                        selected = state.choice == option,
                        onClick = {
                            state.select(option)
                            haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                        },
                        label = {
                            Text(
                                if (option.experimental) "${option.label} · experimental" else option.label,
                                style = MaterialTheme.typography.labelLarge.copy(
                                    fontWeight = Heavy,
                                    letterSpacing = 1.sp,
                                ),
                            )
                        },
                    )
                }
            }
            Text(
                "Selected: ${state.choice.label} — ${state.choice.ladderLabel()}",
                style = MaterialTheme.typography.bodyMedium,
                color = cs.onSurfaceVariant,
            )
            val report = (state.result as? SelfTestResult.Ok)?.report
            if (report != null) {
                Text(
                    "Active backend: ${report.backend.uppercase()} · " +
                        if (report.supportsImages) "text + image" else "text only (no vision encoder)",
                    style = MaterialTheme.typography.bodyMedium,
                    color = cs.primary,
                )
            }
            if (state.choice.experimental) {
                Text(
                    "NPU is experimental: the SM8750 bundle fails on LiteRT-LM 0.18.1/0.19.1 and an " +
                        "uncompiled one JIT-compiles for 140–236 s on open (RECIPE.md §7). Auto never tries it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = cs.onSurfaceVariant,
                )
            }
        }
    }
}

// ---------------------------------------------------------------- live latency

@Composable
private fun LatencyCard(state: SettingsState) {
    val cs = MaterialTheme.colorScheme
    val result = state.result
    val failed = result is SelfTestResult.Failed
    val container = if (failed) cs.errorContainer else cs.primaryContainer
    val content = if (failed) cs.onErrorContainer else cs.onPrimaryContainer

    Card(
        modifier = Modifier.fillMaxWidth().springIn(2),
        shape = Shapes.hero,
        colors = CardDefaults.cardColors(containerColor = container, contentColor = content),
    ) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("Embed latency", color = content.copy(alpha = 0.75f))

            when {
                state.phase == ProbePhase.RUNNING -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = content,
                        strokeWidth = 2.dp,
                    )
                    Text(
                        "Opening ${state.choice.label} and embedding ${SelfTestRunner.SAMPLE_TEXTS.size} samples…",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }

                result is SelfTestResult.Ok -> {
                    val report = result.report
                    Text(
                        LatencyFormat.mean(report.meanMillis),
                        style = MaterialTheme.typography.displaySmall.copy(fontWeight = Heavy),
                        fontFamily = FontFamily.Monospace,
                    )
                    Text(report.headline(), style = MaterialTheme.typography.bodyMedium)
                    report.samples.forEach { sample ->
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                sample.text,
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                LatencyFormat.millis(sample.millis),
                                style = MaterialTheme.typography.titleMedium.copy(fontWeight = Heavy),
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                    Text(
                        "engine load ${LatencyFormat.millis(report.loadMillis)} · warm-up call excluded from the mean",
                        style = MaterialTheme.typography.bodySmall,
                        color = content.copy(alpha = 0.75f),
                    )
                }

                result is SelfTestResult.Failed -> {
                    Text(
                        result.code,
                        style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy),
                        fontFamily = FontFamily.Monospace,
                    )
                    Text(result.message, style = MaterialTheme.typography.bodyMedium)
                    result.reasons.forEach { reason ->
                        Text(
                            reason,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }

                else -> Text(
                    "No measurement yet — pick a backend above.",
                    style = MaterialTheme.typography.bodyLarge,
                )
            }

            if (state.phase != ProbePhase.RUNNING) {
                val haptic = LocalHapticFeedback.current
                Text(
                    "TEST AGAIN",
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .clickable {
                            haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                            state.rerun()
                        }
                        .padding(vertical = 6.dp),
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp),
                )
            }
        }
    }
}

// ---------------------------------------------------------------- model

@Composable
private fun ModelCard(state: SettingsState) {
    val cs = MaterialTheme.colorScheme
    val status = state.model
    val statusColor = when {
        status.isReady -> cs.primary
        status is ModelStatus.Present -> cs.tertiary
        else -> cs.error
    }

    Card(
        modifier = Modifier.fillMaxWidth().springIn(3),
        shape = Shapes.leafMirror,
        colors = CardDefaults.cardColors(containerColor = cs.surfaceContainerHigh, contentColor = cs.onSurface),
    ) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("Model")
            Text(
                "EmbeddingGemma 2 · 740M",
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = Heavy),
            )
            Text(
                "Text + image in one 768-d space, Matryoshka to 256.",
                style = MaterialTheme.typography.bodyMedium,
                color = cs.onSurfaceVariant,
            )
            SectionLabel("File", color = cs.onSurfaceVariant)
            MonospaceLine(status.path)
            Text(
                ModelProbe.line(status),
                style = MaterialTheme.typography.bodyMedium,
                color = statusColor,
            )
            MonospaceLine("sha256 ${ModelProbe.EXPECTED_SHA256}")
            if (!status.isReady) {
                Text(
                    ModelProbe.PUSH_HINT,
                    style = MaterialTheme.typography.bodySmall,
                    color = cs.onSurfaceVariant,
                )
            }
        }
    }
}

// ---------------------------------------------------------------- prefixes

@Composable
private fun PrefixCard(state: SettingsState) {
    val cs = MaterialTheme.colorScheme
    val prefixes = state.prefixes

    Card(
        modifier = Modifier.fillMaxWidth().springIn(4),
        shape = Shapes.leaf,
        colors = CardDefaults.cardColors(containerColor = cs.surfaceContainerHigh, contentColor = cs.onSurface),
    ) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("Prefix set")
            when {
                prefixes != null -> {
                    Text(
                        prefixes.summary(),
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = Heavy),
                        fontFamily = FontFamily.Monospace,
                    )
                    PrefixLine("DOC", prefixes.doc())
                    PrefixLine("QUERY", prefixes.query())
                    PrefixLine("IMAGE", prefixes.image())
                    Text(
                        "Read from the bundled prompts.json at runtime — never hard-coded.",
                        style = MaterialTheme.typography.bodySmall,
                        color = cs.onSurfaceVariant,
                    )
                }

                state.prefixError != null -> {
                    Text(
                        "E_PROMPTS",
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = Heavy),
                        fontFamily = FontFamily.Monospace,
                        color = cs.error,
                    )
                    Text(state.prefixError ?: "", style = MaterialTheme.typography.bodySmall, color = cs.error)
                }

                else -> Text("Reading prompts.json…", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun PrefixLine(label: String, value: String) {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy, letterSpacing = 1.5.sp),
            color = cs.onSurfaceVariant,
        )
        MonospaceLine(value)
    }
}

/** Long unbroken strings (paths, prefixes) scroll instead of being squeezed into an ellipsis. */
@Composable
private fun MonospaceLine(text: String) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ---------------------------------------------------------------- unchanged stubs

/**
 * Live-ranking switch, kept from the B1 stub (it belongs to the scan/rank cards; settings only owns
 * its surface). Its state is local until a rank card persists it.
 */
@Composable
private fun LiveRankingCard(haptics: HapticFeedback) {
    val cs = MaterialTheme.colorScheme
    var liveRanking by remember { mutableStateOf(true) }

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

    Pressable(
        onClick = {
            liveRanking = !liveRanking
            haptics.performHapticFeedback(
                if (liveRanking) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff,
            )
        },
        shape = RoundedCornerShape(toggleCorner),
        containerColor = toggleBackground,
        contentColor = toggleForeground,
        modifier = Modifier.fillMaxWidth().springIn(5),
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
}

@Composable
private fun AboutSection() {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.springIn(6).padding(start = 8.dp, top = 4.dp)) {
        SectionLabel("About")
        Text(
            "dev.hajnina.scanlist.kotlin · 0.1.0 (B6 settings)",
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = cs.onSurfaceVariant,
        )
    }
}
