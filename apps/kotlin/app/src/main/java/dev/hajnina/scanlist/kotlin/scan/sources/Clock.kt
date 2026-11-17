package dev.hajnina.scanlist.kotlin.scan.sources

/**
 * Monotonic millisecond clock, injected wherever time decides behaviour (frame gate, barcode
 * dedupe window, OCR repeat window) so the decisions are JVM-unit-testable with a fake clock.
 *
 * Pure Kotlin on purpose: tests run on the JVM without Android. The Android glue supplies
 * `Clock { SystemClock.elapsedRealtime() }` (see CameraScanPreview.kt); tests advance a long.
 */
fun interface Clock {
    fun nowMs(): Long

    companion object {
        /**
         * Monotonic real time (same base as `SystemClock.elapsedRealtime()`, but pure Kotlin so the
         * file has no Android import): nanoseconds since boot, floored to milliseconds.
         */
        val Default: Clock = Clock { System.nanoTime() / 1_000_000 }
    }
}
