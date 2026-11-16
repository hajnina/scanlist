package dev.hajnina.llmserve

import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/** Material 3 Expressive spring specs (same values as ZenMeter, from material3 ExpressiveMotionTokens). */
private object Motion {
    fun <T> spatial() = spring<T>(0.8f, 380f)
    fun <T> fastSpatial() = spring<T>(0.6f, 800f)
    fun <T> effects() = spring<T>(1f, 1600f)
}
private val Heavy = FontWeight.Black

class MainActivity : ComponentActivity() {
    fun ensureVpn() { val i = Vpn.provision(this); if (i != null) startActivityForResult(i, 2) else Vpn.start(this) }
    @Deprecated("consent dialog result") override fun onActivityResult(r: Int, res: Int, d: Intent?) { super.onActivityResult(r, res, d); android.util.Log.w("LLMVPN", "consent result=$res"); if (r == 2) Vpn.start(this) }
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        enableEdgeToEdge()
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 1)
        // This process is UI only. The server lives in the :server process; (re)start it if it is not running (START = promote to foreground, stop again if the kill switch is off).
        if (Status.read(this)?.enabled != false) LlamaService.start(this)
        setContent { Theme { Dashboard() } }
    }
}

@Composable
private fun Theme(content: @Composable () -> Unit) {
    val ctx = LocalContext.current; val dark = isSystemInDarkTheme()
    val cs = if (Build.VERSION.SDK_INT >= 31) { if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx) }
    else if (dark) darkColorScheme(primary = Color(0xFF5EEAD4)) else lightColorScheme(primary = Color(0xFF006B5F))
    MaterialTheme(colorScheme = cs, content = content)
}

@Composable
private fun Modifier.springIn(i: Int): Modifier {
    val s = remember { Animatable(0f) }; val spec = Motion.spatial<Float>()
    LaunchedEffect(Unit) { delay(i * 80L); s.animateTo(1f, spec) }
    return graphicsLayer { val v = s.value; scaleX = 0.8f + 0.2f * v; scaleY = 0.8f + 0.2f * v; alpha = v.coerceIn(0f, 1f); translationY = (1f - v) * 90f }
}

private fun uptime(ms: Long): String { val s = ms / 1000; return "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) }

@Composable
private fun Dashboard() {
    val ctx = LocalContext.current; val cs = MaterialTheme.colorScheme; val haptic = LocalHapticFeedback.current
    var tick by remember { mutableStateOf(0) }
    var snap by remember { mutableStateOf(Status.read(ctx) ?: Snap()) }
    var lastKick by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(500); tick++
        val n = Status.read(ctx); if (n != null) snap = n
        // Watchdog from the UI side too: the :server process is dead or frozen (snapshot older than 15 s) while the kill switch is ON -> start it again (at most every 10 s).
        if (snap.enabled && !snap.fresh && System.currentTimeMillis() - lastKick > 10_000) { lastKick = System.currentTimeMillis(); runCatching { LlamaService.start(ctx) } } } }
    val on = snap.enabled
    val key = snap.key; val model = snap.model
    val serverUp = snap.fresh
    val state = if (!on) "killed" else if (!serverUp) "server process down, restarting" else snap.state; val ready = serverUp && state == "ready"
    val mem = ActivityManager.MemoryInfo().also { ctx.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }
    val bat = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val temp = (bat?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0
    val pct = bat?.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) ?: 0
    var lastReady by remember { mutableStateOf(ready) }
    LaunchedEffect(ready) { if (ready && !lastReady) haptic.performHapticFeedback(HapticFeedbackType.Confirm); lastReady = ready }

    Column(Modifier.fillMaxSize().background(cs.surface).windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()).padding(16.dp, 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.springIn(0).padding(start = 8.dp, top = 8.dp)) {
            Text("Bonsai server", style = MaterialTheme.typography.displayMedium.copy(fontWeight = Heavy), color = cs.onSurface)
            Text("OpenAI API on the phone NPU", style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant)
        }
        Card(Modifier.fillMaxWidth().springIn(1), shape = RoundedCornerShape(44.dp),
            colors = CardDefaults.cardColors(if (ready) cs.primaryContainer else if (on) cs.tertiaryContainer else cs.surfaceContainerHigh, if (ready) cs.onPrimaryContainer else if (on) cs.onTertiaryContainer else cs.onSurface)) {
            Column(Modifier.padding(28.dp)) {
                Text("STATUS", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp))
                Text(if (on) state.uppercase() else "KILLED", style = MaterialTheme.typography.displaySmall.copy(fontWeight = Heavy))
                Spacer(Modifier.height(6.dp))
                Text("http://${snap.addr ?: "<vpn ip>"}:${Store.PORT}/v1", style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
                Text("${snap.alias} · context ${snap.ctx / 1024}k · NPU (HTP0) · ${if (snap.addr?.startsWith("10.99.") == true) "Oracle IKEv2 VPN" else "no VPN"}", style = MaterialTheme.typography.bodyLarge)
                if (snap.startedAt > 0 && on && serverUp) Text("up ${uptime(System.currentTimeMillis() - snap.startedAt)} · restarts ${snap.restarts} · server pid ${snap.serverPid}", style = MaterialTheme.typography.bodyLarge)
                if (on && Vpn.lastError.isNotEmpty()) Text("VPN: ${Vpn.lastError}", style = MaterialTheme.typography.bodyMedium)
                if (on && state.startsWith("waiting")) { Spacer(Modifier.height(10.dp)); Button({ (ctx as? MainActivity)?.ensureVpn() }) { Text("Connect / authorize VPN") } }
                if (on && state.startsWith("waiting")) { Spacer(Modifier.height(8.dp)); LinearProgressIndicator(Modifier.fillMaxWidth()) }
            }
        }
        // ACTIVITY: what the server is doing right now + totals
        val ph = if (serverUp) snap.phase else "idle"
        fun k(n: Long) = if (n >= 10000) "%.1fk".format(n / 1000.0) else n.toString()
        val cachedPct = if (snap.totIn > 0) (100.0 * snap.totCached / snap.totIn).toInt() else 0
        Card(Modifier.fillMaxWidth().springIn(2), shape = RoundedCornerShape(topStart = 16.dp, topEnd = 52.dp, bottomEnd = 16.dp, bottomStart = 52.dp),
            colors = CardDefaults.cardColors(if (ph == "idle") cs.surfaceContainerHigh else cs.tertiaryContainer, if (ph == "idle") cs.onSurface else cs.onTertiaryContainer)) {
            Column(Modifier.padding(28.dp)) {
                Text("ACTIVITY", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp))
                Text(when (ph) { "prompt" -> "PROMPT ${(snap.pct * 100).toInt()}%"; "generating" -> "GENERATING"; else -> "IDLE" }, style = MaterialTheme.typography.displaySmall.copy(fontWeight = Heavy))
                if (ph == "prompt") {
                    val p by animateFloatAsState(snap.pct, Motion.spatial(), label = "prompt")
                    Spacer(Modifier.height(8.dp))
                    LinearProgressIndicator(progress = { p }, Modifier.fillMaxWidth().height(14.dp), color = cs.tertiary, trackColor = cs.onTertiaryContainer.copy(alpha = 0.15f), strokeCap = androidx.compose.ui.graphics.StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {})
                    Text("${snap.promptTokens} tokens read · ${snap.promptTps.toInt()} tok/s", style = MaterialTheme.typography.titleMedium)
                }
                if (ph == "generating") Text("${snap.decoded} tokens so far · ${"%.1f".format(snap.tps)} tok/s", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    Column { Text("IN", style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy)); Text(k(snap.totIn), style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy)); Text("$cachedPct% cached", style = MaterialTheme.typography.bodySmall) }
                    Column { Text("OUT", style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy)); Text(k(snap.totOut), style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy)); Text(" ", style = MaterialTheme.typography.bodySmall) }
                    Column { Text("REQUESTS", style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy)); Text(snap.totReqs.toString(), style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy)); Text(" ", style = MaterialTheme.typography.bodySmall) }
                }
                Text("Disk cache: ${snap.disk} · ${"%.2f".format(snap.diskBytes / 1e9)} GB of 2.00 GB · ${snap.diskCount} file(s)", style = MaterialTheme.typography.bodyMedium)
                TextButton({ LlamaService.cmd(ctx, LlamaService.ACTION_RESET) }) { Text("Reset totals") }
            }
        }
        Row(Modifier.fillMaxWidth().springIn(3), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Card(Modifier.weight(1f), shape = RoundedCornerShape(36.dp, 12.dp, 36.dp, 12.dp), colors = CardDefaults.cardColors(cs.secondaryContainer, cs.onSecondaryContainer)) {
                Column(Modifier.padding(18.dp, 16.dp)) {
                    Text("RAM FREE", style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy, letterSpacing = 1.sp))
                    Text("%.1f GB".format(mem.availMem / 1e9), style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy)) }
            }
            Card(Modifier.weight(1f), shape = RoundedCornerShape(12.dp, 36.dp, 12.dp, 36.dp), colors = CardDefaults.cardColors(if (temp > 42) cs.errorContainer else cs.surfaceContainerHigh, if (temp > 42) cs.onErrorContainer else cs.onSurface)) {
                Column(Modifier.padding(18.dp, 16.dp)) {
                    Text("BATTERY", style = MaterialTheme.typography.labelSmall.copy(fontWeight = Heavy, letterSpacing = 1.sp))
                    Text("$pct% · ${temp.toInt()}°", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy)) }
            }
        }
        // API key
        Card(onClick = { (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("key", key)); haptic.performHapticFeedback(HapticFeedbackType.Confirm) },
            Modifier.fillMaxWidth().springIn(3), shape = RoundedCornerShape(16.dp, 52.dp, 16.dp, 52.dp), colors = CardDefaults.cardColors(cs.surfaceContainerHigh, cs.onSurface)) {
            Column(Modifier.padding(24.dp)) {
                Text("API KEY (tap to copy)", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp))
                Text(key.take(6) + "…" + key.takeLast(4), style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace)
                TextButton({ LlamaService.cmd(ctx, LlamaService.ACTION_REGEN) }) { Text("Regenerate (restarts server)") }
            }
        }
        // model chips
        val models = snap.models
        Column(Modifier.springIn(4).padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("MODEL", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp), color = cs.onSurfaceVariant)
            if (models.isEmpty()) Text("No .gguf in the app models folder", color = cs.error)
            models.forEach { m -> FilterChip(selected = m == model, onClick = { LlamaService.cmd(ctx, LlamaService.ACTION_SET_MODEL, m) }, label = { Text(m) }) }
        }
        // KILL SWITCH
        val press = remember { MutableInteractionSource() }; val pressed by press.collectIsPressedAsState()
        val sc by animateFloatAsState(if (pressed) 0.94f else 1f, Motion.fastSpatial(), label = "press")
        val corner by animateDpAsState(if (on) 64.dp else 28.dp, Motion.spatial(), label = "corner")
        val bg by animateColorAsState(if (on) cs.primary else cs.errorContainer, Motion.effects(), label = "bg")
        val fg by animateColorAsState(if (on) cs.onPrimary else cs.onErrorContainer, Motion.effects(), label = "fg")
        Surface(onClick = {
            if (!on) { snap = snap.copy(enabled = true); LlamaService.on(ctx); (ctx as? MainActivity)?.let { Vpn.start(it) }; haptic.performHapticFeedback(HapticFeedbackType.ToggleOn) }
            else { snap = snap.copy(enabled = false); LlamaService.cmd(ctx, LlamaService.ACTION_KILL); haptic.performHapticFeedback(HapticFeedbackType.ToggleOff) }
        }, modifier = Modifier.fillMaxWidth().springIn(5).graphicsLayer { scaleX = sc; scaleY = sc }, shape = RoundedCornerShape(corner), color = bg, contentColor = fg, interactionSource = press) {
            Row(Modifier.padding(28.dp, 30.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Server", style = MaterialTheme.typography.headlineMedium.copy(fontWeight = Heavy), maxLines = 1)
                    Text(if (on) "ON: model loaded, API open on Tailscale" else "KILLED: process dead, no autostart", style = MaterialTheme.typography.bodyLarge)
                }
                Switch(checked = on, onCheckedChange = null, modifier = Modifier.padding(start = 28.dp, end = 22.dp).graphicsLayer { scaleX = 1.5f; scaleY = 1.5f },
                    thumbContent = { Text(if (on) "✓" else "✕", fontSize = 12.sp, fontWeight = Heavy) })
            }
        }
        // log tail
        Column(Modifier.springIn(6).padding(horizontal = 8.dp)) {
            if (snap.events.isNotEmpty()) { Text("EVENTS (why it restarted)", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.5.sp), color = cs.onSurfaceVariant)
                Text(snap.events.joinToString("\n"), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = cs.onSurfaceVariant); Spacer(Modifier.height(10.dp)) }
            Text(snap.tail.joinToString("\n"), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.height(24.dp))
    }
}
