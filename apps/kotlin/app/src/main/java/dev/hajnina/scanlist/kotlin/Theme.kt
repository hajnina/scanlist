package dev.hajnina.scanlist.kotlin

import android.os.Build
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

// Material 3 Expressive, built by hand exactly as Bonsai Serve / ZenMeter do it — see
// references/bonsai-ui/STYLE_GUIDE.md §0–§3 and the source this file is copied/adapted from:
// references/bonsai-ui/src/bonsai-serve/app/src/main/java/dev/hajnina/llmserve/MainActivity.kt
// (the material3 1.4.0 Expressive theme/motion APIs are internal; 1.5.x needs compileSdk 37).

/** Dynamic colour on Android 12+, automatic light/dark; Bonsai's teal seed as the pre-12 fallback. */
@Composable
fun ScanListTheme(content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val dark = isSystemInDarkTheme()
    val cs = if (Build.VERSION.SDK_INT >= 31) {
        if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
    } else if (dark) {
        darkColorScheme(primary = Color(0xFF5EEAD4), tertiary = Color(0xFFFFB86B))
    } else {
        lightColorScheme(primary = Color(0xFF006B5F), tertiary = Color(0xFF8A5100))
    }
    MaterialTheme(colorScheme = cs, content = content)
}

/** The one weight this app uses for anything prominent (STYLE_GUIDE.md §3). */
val Heavy = FontWeight.Black

/**
 * Expressive spring specs, copied verbatim from material3 1.4.0's ExpressiveMotionTokens via
 * references/bonsai-ui/STYLE_GUIDE.md §3. Spatial springs for anything that moves or changes
 * shape; effects springs (damping 1, no overshoot) for colour, alpha and numbers.
 */
object Motion {
    fun <T> spatial() = spring<T>(dampingRatio = 0.8f, stiffness = 380f)
    fun <T> fastSpatial() = spring<T>(dampingRatio = 0.6f, stiffness = 800f)
    fun <T> slowSpatial() = spring<T>(dampingRatio = 0.8f, stiffness = 200f)
    fun <T> effects() = spring<T>(dampingRatio = 1f, stiffness = 1600f)
    fun <T> fastEffects() = spring<T>(dampingRatio = 1f, stiffness = 3800f)
    fun <T> slowEffects() = spring<T>(dampingRatio = 1f, stiffness = 800f)
}

/** The project's shape language: very large radii plus asymmetric "leaf" and checkerboard tiles. */
object Shapes {
    val hero = RoundedCornerShape(44.dp)
    val leaf = RoundedCornerShape(topStart = 16.dp, topEnd = 52.dp, bottomEnd = 16.dp, bottomStart = 52.dp)
    val leafMirror = RoundedCornerShape(topStart = 52.dp, topEnd = 16.dp, bottomEnd = 52.dp, bottomStart = 16.dp)
    fun tile(leftFirst: Boolean): RoundedCornerShape = if (leftFirst) {
        RoundedCornerShape(topStart = 36.dp, topEnd = 12.dp, bottomEnd = 36.dp, bottomStart = 12.dp)
    } else {
        RoundedCornerShape(topStart = 12.dp, topEnd = 36.dp, bottomEnd = 12.dp, bottomStart = 36.dp)
    }
}
