package dev.hajnina.scanlist.kotlin.ui

// Card B7 — the "low light" state the polish pass owes the scan screen.
//
// The frame math is one small pure helper next to the other YUV arithmetic
// (`scan/sources/Yuv420Frame.kt` → `Luma.mean`), and this file turns a stream of those numbers into
// UNKNOWN / OK / DIM with hysteresis and a frame-count debounce, so a passing shadow or one dark
// autofocus frame cannot flash a banner. The Android glue only hands the number over
// (CameraScanAnalyzer.onLuma → ScanScreen state).
//
// Thresholds are a heuristic, NOT device-calibrated: CameraX auto-exposure normally parks a lit room
// well above 60 (0..255 luma), while an unlit shelf in the evening sits under 40. There is no phone on
// adb for this card (B0 is device-blocked), so the constants are deliberately conservative and the
// banner is advice, never a hard block: OCR/image ranking still runs in dim frames, it just matches
// worse. Calibrating on the SM8750 device is listed in apps/kotlin/docs/POLISH.md as device-gated.

/** What the scanner can say about the light it is looking at. */
enum class LowLightState {
    /** Not enough frames sampled yet — no banner, no claim. */
    UNKNOWN,

    /** Frames are bright enough; the detector is quiet. */
    OK,

    /** A sustained dark run: show the "low light" advice. */
    DIM,
}

/**
 * Debounced, hysteretic low-light detector.
 *
 *  - [enterBelow]: a frame below this counts as dark,
 *  - [exitAbove]: a frame above this counts as bright,
 *  - between the two is a dead band that counts as neither (hysteresis: the state only flips with
 *    sustained evidence on one side),
 *  - [framesToEnter] dark frames in a row → [LowLightState.DIM],
 *  - [framesToExit] bright frames in a row → [LowLightState.OK].
 *
 * At the camera's 2.5 fps scan gate this is ~2 s to call a room dim and ~4 s to call it bright again.
 * One sample per analysed frame (not per preview frame) keeps it independent of device fps.
 */
class LowLightDetector(
    private val enterBelow: Double = 40.0,
    private val exitAbove: Double = 60.0,
    private val framesToEnter: Int = 5,
    private val framesToExit: Int = 10,
) {
    init {
        require(enterBelow > 0.0 && exitAbove > enterBelow) {
            "need 0 < enterBelow < exitAbove, was $enterBelow / $exitAbove"
        }
        require(framesToEnter >= 1 && framesToExit >= 1) {
            "frame counts must be >= 1, was $framesToEnter / $framesToExit"
        }
    }

    var state: LowLightState = LowLightState.UNKNOWN
        private set

    private var darkRun = 0
    private var brightRun = 0

    /** Feed one frame's mean luma; returns the (possibly unchanged) state. */
    fun sample(luma: Double): LowLightState {
        if (!luma.isFinite()) return state
        when {
            luma < enterBelow -> {
                darkRun++
                brightRun = 0
            }
            luma > exitAbove -> {
                brightRun++
                darkRun = 0
            }
            else -> {
                // Dead band: no evidence either way, so neither counter may accumulate across it.
                darkRun = 0
                brightRun = 0
            }
        }
        if (state != LowLightState.DIM && darkRun >= framesToEnter) state = LowLightState.DIM
        if (state != LowLightState.OK && brightRun >= framesToExit) state = LowLightState.OK
        return state
    }

    /** Camera restarted (tab re-entry): the old room's light says nothing about the new one. */
    fun reset() {
        state = LowLightState.UNKNOWN
        darkRun = 0
        brightRun = 0
    }
}
