package dev.hajnina.scanlist.kotlin.ui

import dev.hajnina.scanlist.kotlin.settings.ModelProbe
import dev.hajnina.scanlist.kotlin.settings.ModelStatus

// Card B7 — the scan screen's degraded-state banner.
//
// Every card in the scan flow is already honest about the ranking it could not do (B5's
// `ScanView.message` / `ScanStatus`), but the *environmental* reasons for a weak scan had no single
// place to be said: no camera permission, no model bundle, a dead embedder, a dark room, no network
// for the barcode name. This file owns that decision as pure data so the priority order is testable
// and the composable only maps it to tonal containers.
//
// Exactly one banner is shown at a time: the first true row wins. Order (most blocking first):
//   1. CAMERA      — nothing at all can be scanned,
//   2. MODEL       — OCR/barcodes still fire, but nothing can be ranked,
//   3. EMBED       — ranking failed at runtime, which is the same practical outcome,
//   4. LOW_LIGHT   — ranking works, it just has less to work with,
//   5. OFFLINE     — only the barcode's *name* needs the network; OCR/image keep working.
// This mirrors the state matrix in apps/kotlin/docs/POLISH.md.

/** Which degraded condition a banner is about (the composable maps this to a colour role). */
enum class ScanBannerKind { CAMERA, MODEL, EMBED, LOW_LIGHT, OFFLINE }

/** The one thing a banner can offer to do. */
enum class ScanBannerAction {
    NONE,

    /** Camera permission is denied: open the system app-settings page for this package. */
    OPEN_SETTINGS,
}

/** One compact banner: caps title, one addressed sentence, optional action. */
data class ScanBanner(
    val kind: ScanBannerKind,
    val title: String,
    val body: String,
    val action: ScanBannerAction = ScanBannerAction.NONE,
)

/**
 * Everything the banner decision may read. `null` means "not known yet" and never produces a banner:
 * the UI must not shout about a state it has not observed.
 */
data class ScanBannerState(
    /** CAMERA permission: null until CameraScanPreview has reported it. */
    val cameraGranted: Boolean? = null,
    /** Filesystem status of the bundle: null until the probe has run. */
    val modelStatus: ModelStatus? = null,
    /** Sustained low light from [LowLightDetector]. */
    val lowLight: LowLightState = LowLightState.UNKNOWN,
    /** The last barcode lookup could not reach Open Food Facts. */
    val offline: Boolean = false,
    /** The embedder's last failure text, if any. */
    val embedError: String? = null,
)

/** The banner for [state], or null when the scan screen has nothing to apologise for. */
fun scanBanner(state: ScanBannerState): ScanBanner? = when {
    state.cameraGranted == false -> ScanBanner(
        kind = ScanBannerKind.CAMERA,
        title = "Camera off",
        body = "Allow camera access to scan products. Lists and settings keep working without it.",
        action = ScanBannerAction.OPEN_SETTINGS,
    )

    state.modelStatus != null && !state.modelStatus.isReady -> {
        val status = state.modelStatus
        // E_NO_MODEL is reserved for a bundle that is genuinely absent; a wrong-size or unreadable
        // file gets its own label instead of the missing-file code.
        val title = when (status) {
            is ModelStatus.Missing -> "${ModelProbe.E_NO_MODEL} · ranking off"
            is ModelStatus.Unreadable -> "Model unreadable · ranking off"
            is ModelStatus.Present -> "Model wrong size · ranking off"
        }
        val body = when (status) {
            is ModelStatus.Missing -> ModelProbe.PUSH_HINT
            is ModelStatus.Unreadable -> "${status.reason}. ${ModelProbe.PUSH_HINT}"
            is ModelStatus.Present -> "${ModelProbe.sizeNote(status.bytes)}. ${ModelProbe.PUSH_HINT}"
        }
        ScanBanner(kind = ScanBannerKind.MODEL, title = title, body = body)
    }

    state.embedError != null -> ScanBanner(
        kind = ScanBannerKind.EMBED,
        title = "Ranking error",
        body = state.embedError,
    )

    state.lowLight == LowLightState.DIM -> ScanBanner(
        kind = ScanBannerKind.LOW_LIGHT,
        title = "Low light",
        body = "Move closer to a light or turn one on — dark frames match poorly. Barcodes still read.",
    )

    state.offline -> ScanBanner(
        kind = ScanBannerKind.OFFLINE,
        title = "Offline · OCR + image only",
        body = "Open Food Facts is unreachable, so barcode names come from the cache. " +
            "Text and image matching still rank the list.",
    )

    else -> null
}
