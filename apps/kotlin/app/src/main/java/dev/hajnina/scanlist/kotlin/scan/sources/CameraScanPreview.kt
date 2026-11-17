package dev.hajnina.scanlist.kotlin.scan.sources

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executors

/**
 * Self-contained camera preview + scan-source wiring for the Scan screen (card B4).
 *
 * This is deliberately a *piece*, not the screen: card B5 owns the Scan screen layout and decides
 * where the preview sits (docs/ARCHITECTURE.md: preview on top ~45 %, ranked list below). Drop this
 * composable in, pass [onSignal] and every barcode / OCR / JPEG signal arrives there.
 *
 * The composable does three thin things (the decisions are all in [ScanFrameCore]):
 *  - asks for CAMERA at most once, with a plain fallback box when denied;
 *  - binds a [Preview] + one [ImageAnalysis] use case with
 *    `STRATEGY_KEEP_ONLY_LATEST` (card B4: never queue frames — a stale frame is worse than none);
 *  - hands frames to [CameraScanAnalyzer] on a single background executor, and tears everything
 *    down in `onDispose` (provider unbind, executor shutdown, ML Kit clients closed).
 *
 * Card B7 additions (polish pass, both optional so B4's call sites compile unchanged):
 *  - [onPermission] reports the live CAMERA state (null is never reported: the first value is the
 *    truth at entry), so the scan screen can show the "camera off" banner and offer app settings;
 *  - [onLuma] forwards the mean luma of each analysed frame to the low-light detector;
 *  - the denied state is a proper M3 Expressive card (caps label, Black title, actionable button)
 *    instead of two plain centred lines, and it can re-ask: the launcher is re-armed on every resume,
 *    so returning from the system settings page starts the preview.
 */
@Composable
fun CameraScanPreview(
    modifier: Modifier = Modifier,
    core: ScanFrameCore = remember { ScanFrameCore(jpegEncoder = AndroidJpegEncoder) },
    onSignal: (ScanSignal) -> Unit = {},
    onPermission: (Boolean) -> Unit = {},
    onLuma: (Double) -> Unit = {},
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cs = MaterialTheme.colorScheme

    var granted by remember { mutableStateOf(hasCameraPermission(context)) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { result -> granted = result }

    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    // B4 review nit: the permission used to be checked once, so returning from the system Settings
    // app (or a permission revoked in the background) left a dead "permission needed" box with no way
    // to re-ask. Re-check on every resume; when it flips to granted the preview simply starts.
    LifecycleResumeEffect(Unit) {
        granted = hasCameraPermission(context)
        onPauseOrDispose { }
    }

    // Card B7: report the live permission state (latest lambda, so the caller may pass a new one on
    // every recomposition without a stale-capture bug).
    val latestOnPermission by rememberUpdatedState(onPermission)
    LaunchedEffect(granted) { latestOnPermission(granted) }

    if (!granted) {
        // Same visual slot as the preview so B5's layout does not jump when permission is refused.
        // Card B7: an actionable M3 Expressive state (caps label, Black title, button), not just text.
        Box(
            modifier = modifier
                .clip(RoundedCornerShape(44.dp)) // STYLE_GUIDE §3 hero radius
                .background(cs.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(horizontal = 24.dp),
            ) {
                Text(
                    "CAMERA OFF",
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Black, letterSpacing = 1.5.sp),
                    color = cs.onSurfaceVariant,
                )
                Text(
                    "Camera permission needed",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Black),
                    color = cs.onSurface,
                )
                Text(
                    "Grant camera access to scan products. Barcodes, text and image matching all need it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = cs.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                androidx.compose.material3.Button(
                    onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                ) {
                    Text(
                        "ALLOW CAMERA",
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Black),
                    )
                }
                Text(
                    "No prompt? Enable Camera for this app in system settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = cs.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
        return
    }

    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    // B4 review nit: a new `onSignal` lambda (every recomposition of the caller) used to be captured
    // once by the DisposableEffect, so the analyzer could keep calling a stale lambda. The effect now
    // reads the latest value through a state holder and is not keyed on it (no camera re-bind).
    val latestOnSignal by rememberUpdatedState(onSignal)
    // Card B7: same treatment for the luma callback (the detector state lives in the screen).
    val latestOnLuma by rememberUpdatedState(onLuma)

    DisposableEffect(granted, previewView, lifecycleOwner) {
        val analyzer = CameraScanAnalyzer(
            core = core,
            onSignal = { signal -> latestOnSignal(signal) },
            onLuma = { luma -> latestOnLuma(luma) },
        )
        val executor = Executors.newSingleThreadExecutor()
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        // B4 review race: if onDispose wins against the providerFuture listener, provider is
        // still null (no unbind) and the listener would bind a CLOSED analyzer to a SHUT-DOWN
        // executor — leaked camera, possible RejectedExecutionException. The guard makes the
        // listener a no-op in that case.
        var disposed = false

        providerFuture.addListener(
            {
                if (disposed) return@addListener
                val cameraProvider = providerFuture.get()
                provider = cameraProvider

                val preview = Preview.Builder()
                    .build()
                    .also { it.surfaceProvider = previewView.surfaceProvider }

                // 720p is plenty: ML Kit decodes barcodes/OCR from it and the embed frame is 384 px.
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(
                                    Size(1280, 720),
                                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                                ),
                            )
                            .build(),
                    )
                    .build()
                    .also { it.setAnalyzer(executor, analyzer) }

                runCatching {
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                }
            },
            ContextCompat.getMainExecutor(context),
        )

        onDispose {
            disposed = true
            provider?.unbindAll()
            executor.shutdown()
            analyzer.close()
        }
    }

    androidx.compose.ui.viewinterop.AndroidView(
        factory = { previewView },
        modifier = modifier,
    )
}

/** True when the app may open the camera; used to skip the request on a re-entry. */
fun hasCameraPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
