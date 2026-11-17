package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.Embedder
import dev.hajnina.scanlist.embed.EmbedderConfig
import dev.hajnina.scanlist.embed.EmbeddingUnavailableException
import dev.hajnina.scanlist.embed.NoBackendException
import java.util.Locale

/** One timed embed call of the settings self-test. */
data class LatencySample(val text: String, val millis: Long)

/**
 * One settings self-test run: the real backend the ladder settled on, the engine load time (the
 * warm-up call), and the per-call [samples]. Pure data; the screen formats it with [LatencyFormat].
 */
data class LatencyReport(
    /** The embedder's own `backend` after the warm-up — "gpu", "cpu", "npu", or "none". */
    val backend: String,
    val samples: List<LatencySample>,
    /** Warm-up call = engine load + model open (GPU 3-8 s, CPU 1-2 s per RECIPE.md §6). */
    val loadMillis: Long = 0L,
    /** Whether the loaded bundle declares a vision encoder (settings shows it; the scan needs it). */
    val supportsImages: Boolean = false,
) {
    val meanMillis: Double
        get() = if (samples.isEmpty()) 0.0 else samples.sumOf { it.millis }.toDouble() / samples.size

    val fastestMillis: Long? get() = samples.minOfOrNull { it.millis }
    val slowestMillis: Long? get() = samples.maxOfOrNull { it.millis }

    /** "gpu · mean 35.2 ms · 3 calls" — the headline the latency card shows. */
    fun headline(): String = "$backend · mean ${LatencyFormat.mean(meanMillis)} · ${samples.size} calls"
}

/** Millisecond formatting in one place so the numbers in tests and on screen agree. */
object LatencyFormat {
    /** "35 ms", or "1.23 s" from a second up (load times are seconds, embed times are milliseconds). */
    fun millis(value: Long): String = if (value < 1000L) {
        "$value ms"
    } else {
        String.format(Locale.ROOT, "%.2f s", value / 1000.0)
    }

    /** Per-call mean: keep one decimal below a second, two above it. */
    fun mean(value: Double): String = if (value < 1000.0) {
        String.format(Locale.ROOT, "%.1f ms", value)
    } else {
        String.format(Locale.ROOT, "%.2f s", value / 1000.0)
    }
}

/** Outcome of one self-test run: the latency report, or why no number could be produced. */
sealed interface SelfTestResult {
    val choice: BackendChoice

    data class Ok(
        override val choice: BackendChoice,
        val report: LatencyReport,
    ) : SelfTestResult

    /** [code] is a status code ("E_NO_BACKEND", "E_NO_MODEL", "E_EMBEDDER"); [reasons] is one line per failed backend. */
    data class Failed(
        override val choice: BackendChoice,
        val code: String,
        val message: String,
        val reasons: List<String> = emptyList(),
    ) : SelfTestResult

    companion object {
        const val E_NO_BACKEND = "E_NO_BACKEND"
        const val E_EMBEDDER = "E_EMBEDDER"
    }
}

/**
 * The settings screen's "live embed latency" (card B6): open an [Embedder] on the picked backend,
 * warm it up once (that is the model load), then embed [samples] one call at a time and time each
 * call. Re-running after a backend switch is what makes the card's Done-when observable: the
 * numbers and the reported backend change with the picker.
 *
 * Everything device-specific is injected ([openEmbedder], [nanoTime], [samples]), so the whole
 * pipeline is a plain JVM unit test with a fake embedder and a fake clock — no device, no model, no
 * weights (AGENTS.md).
 *
 * The embedder is opened **and closed** per run (one resident model at a time, RECIPE.md §7.4). A
 * later card should share the rank runtime's process-wide embedder so the settings probe cannot
 * compete with an open list for memory; that seam lives in the `rank` package and is out of B6's scope.
 */
class SelfTestRunner(
    private val openEmbedder: (EmbedderConfig) -> Embedder,
    private val nanoTime: () -> Long = System::nanoTime,
    /** Three fixed doc texts in the FLATTEN.md docText shape, so every run measures the same work. */
    private val samples: List<String> = SAMPLE_TEXTS,
) {

    fun selfTest(
        choice: BackendChoice,
        modelFile: java.io.File,
        modelId: String = EmbedderConfig.DEFAULT_MODEL_ID,
    ): SelfTestResult {
        // E_NO_MODEL before touching the embedder: the file check is the honest first answer.
        val status = ModelProbe.status(modelFile)
        if (status !is ModelStatus.Present) {
            return SelfTestResult.Failed(choice, ModelProbe.E_NO_MODEL, ModelProbe.line(status))
        }

        var embedder: Embedder? = null
        return try {
            val opened = openEmbedder(choice.config(modelFile, modelId))
            embedder = opened

            // Warm-up: opens the model, runs the backend self-test, pays the first-call cost.
            val loadStart = nanoTime()
            opened.embedDocs(listOf(WARMUP_TEXT))
            val loadMillis = (nanoTime() - loadStart) / NANOS_PER_MILLI

            val measured = samples.map { text ->
                val start = nanoTime()
                opened.embedDocs(listOf(text))
                LatencySample(text = text, millis = (nanoTime() - start) / NANOS_PER_MILLI)
            }
            SelfTestResult.Ok(
                choice = choice,
                report = LatencyReport(
                    backend = opened.backend,
                    samples = measured,
                    loadMillis = loadMillis,
                    supportsImages = opened.supportsImages,
                ),
            )
        } catch (e: NoBackendException) {
            SelfTestResult.Failed(choice, SelfTestResult.E_NO_BACKEND, e.message ?: "no backend", e.reasons)
        } catch (e: EmbeddingUnavailableException) {
            SelfTestResult.Failed(choice, SelfTestResult.E_EMBEDDER, e.message ?: e.javaClass.simpleName)
        } catch (t: Throwable) {
            // A settings probe reports what failed; it must never take the app down.
            SelfTestResult.Failed(choice, SelfTestResult.E_EMBEDDER, "${t.javaClass.simpleName}: ${t.message}")
        } finally {
            runCatching { embedder?.close() }
        }
    }

    companion object {
        private const val NANOS_PER_MILLI = 1_000_000L
        private const val WARMUP_TEXT = "warm-up"

        /** Three fixed shopping-list documents (name; aliases; section path). */
        val SAMPLE_TEXTS: List<String> = listOf(
            "milk",
            "sourdough bread; pan de masa madre; Bakery",
            "cherry tomatoes; tomates cherry; Produce > Vegetables",
        )
    }
}
