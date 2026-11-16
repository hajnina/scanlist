package dev.hajnina.scanlist.embed

/**
 * Loads an engine on the best backend this phone can run, trying candidates in order (GPU, CPU; NPU
 * first only when explicitly allowed). Each attempt is struck in [BackendHealth] when it fails, and a
 * backend the guard has blocked is skipped without being tried.
 *
 * Ported from references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/models/BackendLadder.kt
 * (MnemoThera), reduced to what a library can own: no logging framework, no engine process, no memory
 * picture. The behavioural rules kept from the reference:
 *
 *  * every candidate is tried in order and nothing a backend throws escapes: the next one is tried;
 *  * a backend that fails construction/initialisation **or** its self-test takes a strike;
 *  * a blocked backend is skipped, with the reason in [Loaded.skipped] / [NoBackendException.reasons];
 *  * the CPU is the fallback and is never blocked, so a ladder always ends on the CPU or throws;
 *  * an engine that was built but failed a later step is closed exactly once.
 *
 * [open] must create **and initialise** the engine; [prove] must run the self-test (and throw when the
 * output is wrong). [close] is called only for an engine that was already opened.
 */
class BackendLadder(
    private val health: BackendHealth,
    private val log: Logger = Logger.NONE,
) {
    fun interface Logger {
        fun log(event: String, detail: String)

        companion object {
            val NONE = Logger { _, _ -> }
        }
    }

    class Loaded<T : Any>(
        val backend: EmbedBackend,
        val engine: T,
        /** One line per candidate that was skipped or failed before [backend] was proven. */
        val skipped: List<String>,
    )

    fun <T : Any> load(
        model: String,
        candidates: List<EmbedBackend>,
        open: (EmbedBackend) -> T,
        prove: (EmbedBackend, T) -> Unit,
        close: (T) -> Unit,
    ): Loaded<T> {
        val order = candidates.distinct()
        require(order.isNotEmpty()) { "no backend candidates" }
        val reasons = ArrayList<String>()
        log.log("ladder_start", "model=$model candidates=${order.joinToString(",")}")
        for (backend in order) {
            if (health.blocked(backend)) {
                val record = health.record(backend)
                val reason = "${backend.id}: blocked on this device (${record?.reason ?: "no reason recorded"})"
                reasons += reason
                log.log("backend_skipped_blocked", reason)
                continue
            }
            var engine: T? = null
            try {
                log.log("backend_attempting", "backend=${backend.id}")
                engine = open(backend)
                prove(backend, engine)
                health.proven(backend)
                log.log("backend_proven", "backend=${backend.id} skipped=${reasons.size}")
                return Loaded(backend, engine, reasons)
            } catch (t: Throwable) {
                // A backend failing must never take the load down: strike it, close what it built, move on.
                val reason = "${backend.id}: ${t.javaClass.simpleName}: ${t.message}"
                engine?.let { built -> runCatching { close(built) }.onFailure { log.log("backend_close_failed", it.toString()) } }
                val record = health.strike(backend, reason)
                reasons += reason
                log.log("backend_failed", "$reason strikes=${record.strikes} blocked=${record.blocked}")
            }
        }
        val failure = NoBackendException(order.map { it.id }, reasons)
        log.log("ladder_failed", failure.message ?: "no backend")
        throw failure
    }
}
