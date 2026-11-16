package dev.hajnina.zenmeter

import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.text.NumberFormat

/**
 * Material 3 Expressive spring physics, copied from the library's own ExpressiveMotionTokens (read from material3 1.4.0 bytecode, 2026-10-27).
 * The public MaterialExpressiveTheme/MotionScheme APIs are `internal` in 1.4.0 (public from 1.5, which needs compileSdk 37 + AGP 9: not on this toolchain yet).
 * Spatial springs (position/size/shape) overshoot; effects springs (colour/alpha/numbers) do not.
 */
private object Motion {
    fun <T> defaultSpatialSpec() = spring<T>(0.8f, 380f)
    fun <T> fastSpatialSpec() = spring<T>(0.6f, 800f)
    fun <T> slowSpatialSpec() = spring<T>(0.8f, 200f)
    fun <T> defaultEffectsSpec() = spring<T>(1f, 1600f)
    fun <T> fastEffectsSpec() = spring<T>(1f, 3800f)
    fun <T> slowEffectsSpec() = spring<T>(1f, 800f)
}

/** Read-only dashboard + ONE control (Allow resets). Everything else is the API (see Proxy.kt / README). Material 3 Expressive: spring motion, haptics, dynamic colour. */
class MainActivity : ComponentActivity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        enableEdgeToEdge()
        ProxyService.ctx = applicationContext; Store.init(this)
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 1)
        ProxyService.start(this)
        setContent { ZenTheme { Dashboard() } }
    }
}

private data class Snap(
    val epoch: Int, val fed: Boolean, val up: Long, val down: Long, val totalUp: Long, val totalDown: Long,
    val input: Long, val output: Long, val reasoning: Long, val cacheRead: Long, val reqs: Long, val rej: Long, val prevLimit: Long?,
    val heat: String, val ip: String?, val listen: String, val resetState: String, val resetResult: String, val refusals: Long, val sim: Long,
) { val fresh get() = input + output + reasoning }

private fun snap(): Snap {
    val e = Store.cur
    return Snap(e.n, e.imported, e.bytesUp, e.bytesDown, Store.totalUp, Store.totalDown, e.input, e.output, e.reasoning, e.cacheRead,
        if (e.imported) e.reqs else 0, if (e.imported) e.rej429 else 0,
        Store.epochs.dropLast(1).lastOrNull { it.reqAtFirst429 >= 0 }?.reqAtFirst429,
        Status.health(ProxyService.ctx).let { "${it.getString("thermal_name")} · battery ${it.getDouble("battery_temp_c")} °C ${it.getInt("battery_pct")}%" },
        e.ip, Proxy.listening().joinToString().ifEmpty { "Tailscale not connected" }, Resetter.state, Resetter.lastResult,
        Store.refusalCount, Store.mobileDelta())
}

@Composable
private fun ZenTheme(content: @Composable () -> Unit) {
    val ctx = LocalContext.current; val dark = isSystemInDarkTheme()
    val cs = if (Build.VERSION.SDK_INT >= 31) { if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx) }
    else if (dark) darkColorScheme(primary = Color(0xFF5EEAD4), tertiary = Color(0xFFFFB86B)) else lightColorScheme(primary = Color(0xFF006B5F), tertiary = Color(0xFF8A5100))
    MaterialTheme(colorScheme = cs, content = content)
}

/** Cards spring in one after the other (physical, slightly overshooting: the expressive spatial spec). */
@Composable
private fun Modifier.springIn(i: Int): Modifier {
    val s = remember { Animatable(0f) }; val spec = Motion.defaultSpatialSpec<Float>()
    LaunchedEffect(Unit) { delay(i * 80L); s.animateTo(1f, spec) }
    return graphicsLayer { val v = s.value; scaleX = 0.8f + 0.2f * v; scaleY = 0.8f + 0.2f * v; alpha = v.coerceIn(0f, 1f); translationY = (1f - v) * 90f }
}

/** A number that counts to its new value and gives a small springy bump whenever it changes. */
@Composable
private fun Num(value: Double, decimals: Int, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val shown by animateFloatAsState(value.toFloat(), Motion.slowEffectsSpec(), label = "count")
    val bump = remember { Animatable(1f) }; var first by remember { mutableStateOf(true) }
    LaunchedEffect(value) { if (first) { first = false } else { bump.snapTo(1.08f); bump.animateTo(1f, spring(dampingRatio = 0.35f, stiffness = 380f)) } }
    val txt = if (decimals == 0) NumberFormat.getIntegerInstance().format(shown.toLong()) else "%.${decimals}f".format(shown)
    Text(txt, style = style, color = color, modifier = modifier.graphicsLayer { scaleX = bump.value; scaleY = bump.value })
}

private fun mb(b: Long) = b / 1048576.0
private val Heavy = FontWeight.Black

@Composable
private fun Dashboard() {
    val s by produceState(snap()) { while (true) { value = snap(); delay(1000) } }
    val cs = MaterialTheme.colorScheme; val haptic = LocalHapticFeedback.current
    var allow by remember { mutableStateOf(Store.allowResets) }
    val busy = s.resetState != "idle"
    // haptics for things that happen on their own
    var lastRej by remember { mutableStateOf(s.rej) }
    LaunchedEffect(s.rej) { if (s.rej > lastRej) haptic.performHapticFeedback(HapticFeedbackType.Reject); lastRej = s.rej }
    var wasBusy by remember { mutableStateOf(busy) }
    LaunchedEffect(busy) { if (busy && !wasBusy) haptic.performHapticFeedback(HapticFeedbackType.LongPress) else if (!busy && wasBusy) haptic.performHapticFeedback(HapticFeedbackType.Confirm); wasBusy = busy }

    Column(Modifier.fillMaxSize().then(Modifier.background(cs.surface)).windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.springIn(0).padding(start = 8.dp, top = 8.dp)) {
            Text("Zen traffic", style = MaterialTheme.typography.displayMedium.copy(fontWeight = Heavy), color = cs.onSurface)
            Text("epoch #${s.epoch} · ${if (s.fed) "tokens from laptop" else "bytes only, no token feed"}", style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant)
        }
        // traffic
        Card(Modifier.fillMaxWidth().springIn(1), shape = RoundedCornerShape(44.dp), colors = CardDefaults.cardColors(cs.primaryContainer, cs.onPrimaryContainer)) {
            Column(Modifier.padding(28.dp)) {
                Text("TRAFFIC THIS EPOCH", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp))
                Row(verticalAlignment = Alignment.Bottom) {
                    Num(mb(s.up + s.down), 1, MaterialTheme.typography.displayLarge.copy(fontSize = 72.sp, fontWeight = Heavy), cs.onPrimaryContainer)
                    Text(" MB", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy), modifier = Modifier.padding(bottom = 10.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    Row { Text("↑ ", fontWeight = Heavy); Num(mb(s.up), 2, MaterialTheme.typography.titleLarge, cs.onPrimaryContainer); Text(" MB", style = MaterialTheme.typography.titleLarge) }
                    Row { Text("↓ ", fontWeight = Heavy); Num(mb(s.down), 2, MaterialTheme.typography.titleLarge, cs.onPrimaryContainer); Text(" MB", style = MaterialTheme.typography.titleLarge) }
                }
                Spacer(Modifier.height(6.dp))
                Row { Text("all time ", style = MaterialTheme.typography.bodyLarge); Num(mb(s.totalUp + s.totalDown), 1, MaterialTheme.typography.bodyLarge.copy(fontWeight = Heavy), cs.onPrimaryContainer); Text(" MB", style = MaterialTheme.typography.bodyLarge) }
                Row { Text("phone SIM ", style = MaterialTheme.typography.bodyLarge); Num(mb(s.sim), 1, MaterialTheme.typography.bodyLarge.copy(fontWeight = Heavy), cs.onPrimaryContainer); Text(" MB (whole phone, this epoch)", style = MaterialTheme.typography.bodyLarge) }
            }
        }
        // tokens
        Card(Modifier.fillMaxWidth().springIn(2), shape = RoundedCornerShape(topStart = 16.dp, topEnd = 52.dp, bottomEnd = 16.dp, bottomStart = 52.dp), colors = CardDefaults.cardColors(cs.tertiaryContainer, cs.onTertiaryContainer)) {
            Column(Modifier.padding(28.dp)) {
                Text("FRESH TOKENS", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp))
                if (s.fed) Num(s.fresh.toDouble(), 0, MaterialTheme.typography.displayLarge.copy(fontSize = 56.sp, fontWeight = Heavy), cs.onTertiaryContainer)
                else Text("n/a", style = MaterialTheme.typography.displayLarge.copy(fontSize = 56.sp, fontWeight = Heavy))
                val perM = if (s.fresh > 0) mb(s.up + s.down) / (s.fresh / 1e6) else null
                Text(if (perM != null) "%.1f MB per 1M fresh tokens".format(perM) else "waiting for the laptop feed", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(14.dp))
                val limit = (s.prevLimit ?: 850L).toFloat(); val p by animateFloatAsState((s.reqs / limit).coerceIn(0f, 1f), Motion.defaultSpatialSpec(), label = "req")
                LinearProgressIndicator(progress = { p }, Modifier.fillMaxWidth().height(14.dp).clip(RoundedCornerShape(7.dp)),
                    color = if (p > 0.85f) cs.error else cs.tertiary, trackColor = cs.onTertiaryContainer.copy(alpha = 0.15f), strokeCap = androidx.compose.ui.graphics.StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {})
                Text("${s.reqs} requests of ~${limit.toInt()} ${if (s.prevLimit != null) "(where an earlier IP hit 429)" else "(guess: yesterday's limit)"}", style = MaterialTheme.typography.bodyMedium)
            }
        }
        // stat tiles
        Row(Modifier.fillMaxWidth().springIn(3), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile("429s", s.rej.toDouble(), if (s.rej > 0) cs.errorContainer else cs.secondaryContainer, if (s.rej > 0) cs.onErrorContainer else cs.onSecondaryContainer, RoundedCornerShape(36.dp, 12.dp, 36.dp, 12.dp), Modifier.weight(1f))
            Tile("input", s.input.toDouble(), cs.surfaceContainerHigh, cs.onSurface, RoundedCornerShape(12.dp, 36.dp, 12.dp, 36.dp), Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth().springIn(4), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile("output", s.output.toDouble(), cs.surfaceContainerHigh, cs.onSurface, RoundedCornerShape(12.dp, 36.dp, 12.dp, 36.dp), Modifier.weight(1f))
            Tile("reasoning", s.reasoning.toDouble(), cs.surfaceContainerHigh, cs.onSurface, RoundedCornerShape(36.dp, 12.dp, 36.dp, 12.dp), Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth().springIn(5), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile("cache read", s.cacheRead.toDouble(), cs.surfaceContainerHigh, cs.onSurface, RoundedCornerShape(36.dp, 12.dp, 36.dp, 12.dp), Modifier.weight(1f))
            Tile("requests", s.reqs.toDouble(), cs.surfaceContainerHigh, cs.onSurface, RoundedCornerShape(12.dp, 36.dp, 12.dp, 36.dp), Modifier.weight(1f))
        }
        // the one control
        val press = remember { MutableInteractionSource() }; val pressed by press.collectIsPressedAsState()
        val sc by animateFloatAsState(if (pressed) 0.94f else 1f, Motion.fastSpatialSpec(), label = "press")
        val corner by animateDpAsState(if (allow) 64.dp else 28.dp, Motion.defaultSpatialSpec(), label = "corner")
        val bg by animateColorAsState(if (allow) cs.primary else cs.surfaceContainerHighest, Motion.defaultEffectsSpec(), label = "bg")
        val fg by animateColorAsState(if (allow) cs.onPrimary else cs.onSurface, Motion.defaultEffectsSpec(), label = "fg")
        Surface(onClick = { allow = !allow; Store.allowResets = allow; haptic.performHapticFeedback(if (allow) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff) },
            modifier = Modifier.fillMaxWidth().springIn(6).graphicsLayer { scaleX = sc; scaleY = sc }, shape = RoundedCornerShape(corner), color = bg, contentColor = fg, interactionSource = press) {
            Row(Modifier.padding(horizontal = 28.dp, vertical = 30.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Allow resets", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy), maxLines = 1)
                    Text(if (allow) "ON: the API may reset the IP" else "OFF: the API refuses resets", style = MaterialTheme.typography.bodyLarge)
                }
                Switch(checked = allow, onCheckedChange = null, modifier = Modifier.padding(start = 28.dp, end = 22.dp).graphicsLayer { scaleX = 1.5f; scaleY = 1.5f },
                    thumbContent = { Text(if (allow) "✓" else "✕", fontSize = 12.sp, fontWeight = Heavy) })
            }
        }
        // read-only status
        Column(Modifier.springIn(7).padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (busy) { Text("RESET: ${s.resetState}", style = MaterialTheme.typography.titleMedium.copy(fontWeight = Heavy), color = cs.tertiary); LinearProgressIndicator(Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp))) }
            else if (s.resetResult.isNotEmpty()) Text("last reset: ${s.resetResult}", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            Text("heat ${s.heat}", style = MaterialTheme.typography.bodyMedium, color = if (s.heat.startsWith("severe") || s.heat.startsWith("critical")) cs.error else cs.onSurfaceVariant)
            Text("IP ${s.ip ?: "?"} · listening ${s.listen}", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            Text("reset via routine \"${Store.routineKeyword}\" · refusals ${s.refusals}", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Tile(label: String, value: Double, bg: Color, fg: Color, shape: RoundedCornerShape, modifier: Modifier) {
    Card(modifier, shape = shape, colors = CardDefaults.cardColors(bg, fg)) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp)) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy, letterSpacing = 1.sp))
            Num(value, 0, MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy), fg)
        }
    }
}

