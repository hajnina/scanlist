package dev.hajnina.scanlist.embed

import android.content.SharedPreferences

/**
 * The accelerators this library knows, in the order the ladder prefers them: NPU (opt-in only), GPU,
 * CPU. Ids are the lowercase strings of the cross-track spec ("npu|gpu|cpu"), so logs and the settings
 * screen read the same in all three builds.
 *
 * Ported from references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/models/Accelerators.kt
 * (MnemoThera), cut down to the three LiteRT-LM backends ScanList uses. NPU is **never** in the
 * automatic order: RECIPE.md §7 says the EmbeddingGemma NPU path is experimental (SM8750 bundle fails
 * on 0.18.1/0.19.1; JIT compile 140-236 s), so it is only tried when [EmbedderConfig.allowNpu] is set.
 */
enum class EmbedBackend(val id: String) {
    NPU(Embedder.BACKEND_NPU),
    GPU(Embedder.BACKEND_GPU),
    CPU(Embedder.BACKEND_CPU),
    ;

    val isCpu: Boolean get() = this == CPU

    companion object {
        fun fromId(id: String): EmbedBackend? = entries.firstOrNull { it.id == id.trim().lowercase() }
    }
}

/** Durable storage for [BackendHealth]: SharedPreferences on a device, an in-memory map in tests. */
interface BackendStore {
    fun get(key: String): String?
    fun put(key: String, value: String?)
    fun keys(): Set<String>

    fun putAll(values: Map<String, String?>) = values.forEach { (k, v) -> put(k, v) }
}

/** SharedPreferences-backed store. `commit()` is used because the next thing after a strike can be a process kill. */
class SharedPreferencesBackendStore(private val prefs: SharedPreferences) : BackendStore {
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        if (value == null) prefs.edit().remove(key).commit() else prefs.edit().putString(key, value).commit()
    }

    override fun keys(): Set<String> = prefs.all.keys.toSet()
}

/** For tests and for a caller that wants the history to last only for the session. */
class InMemoryBackendStore(initial: Map<String, String> = emptyMap()) : BackendStore {
    private val values = LinkedHashMap<String, String>(initial)
    override fun get(key: String): String? = values[key]
    override fun put(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }

    override fun keys(): Set<String> = values.keys.toSet()
    override fun toString(): String = values.toString()
}

/**
 * What this device has shown per model and backend: strikes, ever-proven, blocked. The self-test proof
 * is recorded here so a backend that returns wrong numbers (or cannot load) is not tried over and over.
 *
 * Ported from references/embeddinggemma/src/app/src/main/java/com/therapylocal/app/models/BackendGuard.kt
 * (MnemoThera), keeping the part ScanList needs and dropping the process-death/exit reconstruction
 * (that is a device-level concern for card B0):
 *
 *  * a caught failure is a **strike**;
 *  * a backend never proven on this build is **blocked** after [BLOCK_UNPROVEN] strikes ("this device
 *    really cannot do this"), one that was proven needs [BLOCK_PROVEN] (a later failure is more likely
 *    transient — memory pressure);
 *  * the **CPU is never blocked**: it is the last resort and the golden reference itself;
 *  * strikes are cleared when the app closes a proven GPU/NPU engine itself ([cleanClose]): it loaded
 *    and survived its work. Loading alone does not clear them;
 *  * [reset] forgets everything (a manual "test again" in settings).
 *
 * A different model file has different behaviour, so records are keyed by [modelId].
 */
class BackendHealth(
    private val modelId: String,
    private val store: BackendStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Record(
        val strikes: Int,
        val everProven: Boolean,
        val blocked: Boolean,
        val at: Long,
        val reason: String,
    ) {
        /** "strikes|everProven|blocked|at|reason"; split with a limit so a '|' in the reason cannot break it. */
        internal fun encode(): String = listOf(strikes, everProven, blocked, at, reason).joinToString("|")

        companion object {
            internal fun decode(value: String?): Record? {
                val parts = value?.split('|', limit = 5) ?: return null
                if (parts.size != 5) return null
                return runCatching {
                    Record(
                        strikes = parts[0].toInt(),
                        everProven = parts[1].toBoolean(),
                        blocked = parts[2].toBoolean(),
                        at = parts[3].toLong(),
                        reason = parts[4],
                    )
                }.getOrNull()
            }
        }
    }

    fun record(backend: EmbedBackend): Record? = Record.decode(store.get(key(backend)))

    /** Whether [backend] is blocked on this device. The CPU never is. */
    fun blocked(backend: EmbedBackend): Boolean {
        if (backend.isCpu) return false
        return record(backend)?.blocked == true
    }

    /** A caught failure while loading or proving [backend]. Returns the record after the strike. */
    @Synchronized
    fun strike(backend: EmbedBackend, reason: String?): Record {
        val previous = record(backend)
        val strikes = (previous?.strikes ?: 0) + 1
        val everProven = previous?.everProven == true
        val limit = if (everProven) BLOCK_PROVEN else BLOCK_UNPROVEN
        val blocked = !backend.isCpu && strikes >= limit
        val next = Record(strikes, everProven, blocked, now(), (reason ?: "error").replace('|', '/').take(MAX_REASON))
        store.put(key(backend), next.encode())
        return next
    }

    /** [backend] loaded and passed its self-test. Strikes stay until a clean [cleanClose]. */
    @Synchronized
    fun proven(backend: EmbedBackend) {
        val previous = record(backend)
        val next = Record(previous?.strikes ?: 0, everProven = true, blocked = false, at = now(), reason = "proven on this device")
        store.put(key(backend), next.encode())
    }

    /**
     * The app closed an engine on [backend] itself: it loaded and survived its work, so its strikes are
     * cleared. The CPU has nothing to clear (it is never blocked).
     */
    @Synchronized
    fun cleanClose(backend: EmbedBackend) {
        if (backend.isCpu) return
        val previous = record(backend) ?: return
        if (!previous.everProven || previous.strikes == 0) return
        store.put(key(backend), previous.copy(strikes = 0, blocked = false, at = now(), reason = "loaded and closed cleanly").encode())
    }

    /** Forgets every strike and block for this model ("test again" in settings). */
    @Synchronized
    fun reset() {
        val prefix = prefix()
        store.putAll(store.keys().filter { it.startsWith(prefix) }.associateWith<String, String?> { null })
    }

    private fun key(backend: EmbedBackend) = prefix() + backend.name

    private fun prefix() = "embed:$modelId:"

    companion object {
        /** A backend never proven on this device is blocked after this many strikes (MnemoThera's BLOCK_UNPROVEN). */
        const val BLOCK_UNPROVEN = 2

        /** A backend that was proven once needs this many strikes (MnemoThera's BLOCK_PROVEN). */
        const val BLOCK_PROVEN = 3

        private const val MAX_REASON = 300
    }
}
