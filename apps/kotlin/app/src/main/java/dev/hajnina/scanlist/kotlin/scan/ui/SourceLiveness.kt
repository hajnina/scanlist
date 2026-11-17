package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.scan.sources.ScanKind

/**
 * Which source chips are lit (card B5 + the lead's Barcode Buddy note).
 *
 * A chip is lit for [stickyMs] after its source last fired, so a barcode decoded once is still
 * visible while the user reads the hero card — a 100 ms flash would be invisible. The sticky window
 * is **not** a scan mode of its own: [clear] is called on a tick, which is the "auto-revert after one
 * tick" half of the pattern (the next signal re-lights the chips).
 *
 * Pure arithmetic on an injected timeline.
 */
class SourceLiveness(private val stickyMs: Long = DEFAULT_STICKY_MS) {

    init {
        require(stickyMs > 0) { "stickyMs must be > 0" }
    }

    private val lastFiredAt = HashMap<ScanKind, Long>()

    fun fire(kind: ScanKind, nowMs: Long) {
        lastFiredAt[kind] = nowMs
    }

    /** True while [kind] fired within the sticky window ending at [nowMs]. */
    fun lit(kind: ScanKind, nowMs: Long): Boolean =
        lastFiredAt[kind]?.let { nowMs - it < stickyMs } ?: false

    /** One tick (or scan start/stop): no source is "live" any more. */
    fun clear() = lastFiredAt.clear()

    companion object {
        /** Long enough to read the chip, short enough to go dark when the user moves away. */
        const val DEFAULT_STICKY_MS: Long = 4_000L
    }
}
