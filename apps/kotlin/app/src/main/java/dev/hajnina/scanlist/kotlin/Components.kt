package dev.hajnina.scanlist.kotlin

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

// Reusable expressive pieces, adapted from references/bonsai-ui/STYLE_GUIDE.md §4 and
// references/bonsai-ui/src/bonsai-serve/app/src/main/java/dev/hajnina/llmserve/MainActivity.kt.

/**
 * Staggered entrance: cards scale 0.8->1, fade 0->1 and rise 90px, with an 80 ms stagger.
 * Copied from Bonsai's `Modifier.springIn(i)`; only give the first handful of items an index.
 */
@Composable
fun Modifier.springIn(index: Int): Modifier {
    val progress = remember { Animatable(0f) }
    val spec = Motion.spatial<Float>()
    LaunchedEffect(index) {
        delay(index * 80L)
        progress.animateTo(1f, spec)
    }
    return graphicsLayer {
        val v = progress.value
        scaleX = 0.8f + 0.2f * v
        scaleY = 0.8f + 0.2f * v
        alpha = v.coerceIn(0f, 1f)
        translationY = (1f - v) * 90f
    }
}

/** Screen title + subtitle: displayMedium Black over onSurfaceVariant (STYLE_GUIDE.md §3). */
@Composable
fun ScreenHeader(title: String, subtitle: String, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.padding(start = 8.dp, top = 4.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.displayMedium.copy(fontWeight = Heavy),
            color = cs.onSurface,
        )
        Text(subtitle, style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant)
    }
}

/** All-caps tracked label that sits inside every card, as in Bonsai. */
@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp),
        color = color,
        modifier = modifier,
    )
}

/**
 * Tappable tonal surface with Bonsai's press feedback: scale 1 -> 0.96 on the fastSpatial spring.
 * Bonsai's kill-switch Surface(onClick, interactionSource) is the source for the interaction plumbing.
 */
@Composable
fun Pressable(
    onClick: () -> Unit,
    shape: Shape,
    containerColor: Color,
    contentColor: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.96f else 1f,
        animationSpec = Motion.fastSpatial(),
        label = "pressScale",
    )
    Surface(
        onClick = onClick,
        modifier = modifier.graphicsLayer {
            scaleX = scale
            scaleY = scale
        },
        shape = shape,
        color = containerColor,
        contentColor = contentColor,
        interactionSource = interaction,
        content = content,
    )
}

/** Bottom tab strip: three pills that morph corners, crossfade colour and spring on press. */
@Composable
fun TabBar(selected: Tab, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Tab.entries.forEach { tab ->
            TabPill(
                label = tab.label,
                selected = tab == selected,
                onClick = { onSelect(tab) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun TabPill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()

    // Press feedback 1 -> 0.94 (fastSpatial), corner 18 <-> 30 dp (spatial), colour with effects.
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.94f else 1f,
        animationSpec = Motion.fastSpatial(),
        label = "tabScale",
    )
    val corner by animateDpAsState(
        targetValue = if (selected) 30.dp else 18.dp,
        animationSpec = Motion.spatial(),
        label = "tabCorner",
    )
    val background by animateColorAsState(
        targetValue = if (selected) cs.primary else cs.surfaceContainerHigh,
        animationSpec = Motion.effects(),
        label = "tabBackground",
    )
    val foreground by animateColorAsState(
        targetValue = if (selected) cs.onPrimary else cs.onSurfaceVariant,
        animationSpec = Motion.effects(),
        label = "tabForeground",
    )

    Surface(
        onClick = {
            haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
            onClick()
        },
        modifier = modifier.graphicsLayer {
            scaleX = scale
            scaleY = scale
        },
        shape = RoundedCornerShape(corner),
        color = background,
        contentColor = foreground,
        interactionSource = interaction,
    ) {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp),
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 13.dp),
        )
    }
}
