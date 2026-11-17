package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.Embedder
import dev.hajnina.scanlist.embed.EmbedderConfig

/** A deterministic clock the fake embedder advances, so a "latency" is exactly what the test set. */
class FakeClock(var nanos: Long = 0L) {
    fun now(): Long = nanos

    fun advanceMillis(millis: Long) {
        nanos += millis * 1_000_000L
    }
}

/**
 * Hand-rolled [Embedder] stand-in for the settings self-test (no device, no weights — AGENTS.md).
 * The first [embedDocs] call costs [loadMillis] (the model open); later calls cost [callMillis]. Every
 * text is recorded so a test can prove the three fixed samples were embedded in order.
 */
class FakeEmbedder(
    override val backend: String = "gpu",
    override val dims: Int = 256,
    override val supportsImages: Boolean = true,
    override val modelId: String = EmbedderConfig.DEFAULT_MODEL_ID,
    private val clock: FakeClock = FakeClock(),
    private val loadMillis: Long = 100L,
    private val callMillis: Long = 20L,
    private val failure: (() -> Throwable)? = null,
) : Embedder {

    var closed: Boolean = false
        private set

    val embedded: MutableList<String> = mutableListOf()

    private var opened: Boolean = false

    override fun embedDocs(texts: List<String>): List<FloatArray> {
        failure?.let { throw it() }
        if (!opened) {
            opened = true
            clock.advanceMillis(loadMillis)
        } else {
            clock.advanceMillis(callMillis)
        }
        embedded += texts
        return texts.map { FloatArray(dims) }
    }

    override fun embedQuery(text: String): FloatArray = FloatArray(dims)

    override fun embedImage(jpeg: ByteArray): FloatArray = FloatArray(dims)

    override fun close() {
        closed = true
    }
}
