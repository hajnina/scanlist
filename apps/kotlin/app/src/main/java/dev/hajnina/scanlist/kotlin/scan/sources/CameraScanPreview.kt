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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
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
 */
@Composable
fun CameraScanPreview(
    modifier: Modifier = Modifier,
    core: ScanFrameCore = remember { ScanFrameCore(jpegEncoder = AndroidJpegEncoder) },
    onSignal: (ScanSignal) -> Unit = {},
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

    if (!granted) {
        // Same visual slot as the preview so B5's layout does not jump when permission is refused.
        Box(
            modifier = modifier
                .clip(RoundedCornerShape(44.dp))
                .background(cs.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    "Camera permission needed",
                    style = MaterialTheme.typography.titleMedium,
                    color = cs.onSurfaceVariant,
                )
                Text(
                    "Grant camera access to scan products.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = cs.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp),
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

    DisposableEffect(granted, previewView, lifecycleOwner) {
        val analyzer = CameraScanAnalyzer(core = core, onSignal = onSignal)
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
