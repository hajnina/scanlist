package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * Frames-per-second gate for the image-embedding source (card B4: "≤ 2.5 fps").
 *
 * At 30 fps the camera produces far more frames than a 768-d image embedding can absorb, so the
 * gate keeps at most one frame per [minIntervalMs]. It is pure: the caller passes the clock reading,
 * tests pass a fake timeline. The first call always passes so a stationary camera still gets a frame.
 *
 * Not thread-safe by itself — the Android glue calls it from CameraX's single analysis executor.
 */
class FrameSampler(
    private val clock: Clock = Clock.Default,
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
) {
    init {
        require(minIntervalMs > 0) { "minIntervalMs must be > 0, was $minIntervalMs" }
    }

    private var lastEmitMs: Long = NEVER

    /** True when this frame may be emitted; records the time when it says yes. */
    fun shouldEmit(nowMs: Long = clock.nowMs()): Boolean {
        if (lastEmitMs != NEVER && nowMs - lastEmitMs < minIntervalMs) return false
        lastEmitMs = nowMs
        return true
    }

    /** Forget the last emission (e.g. the analysis use case was rebound). */
    fun reset() {
        lastEmitMs = NEVER
    }

    companion object {
        /** 2.5 fps = one frame every 400 ms. */
        const val TARGET_FPS = 2.5
        const val DEFAULT_MIN_INTERVAL_MS = (1000 / TARGET_FPS).toLong()
        private const val NEVER = Long.MIN_VALUE
    }
}
