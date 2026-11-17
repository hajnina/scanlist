package dev.hajnina.scanlist.rn.embed

import android.net.Uri
import android.os.SystemClock
import android.util.Base64 as AndroidBase64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import dev.hajnina.scanlist.embed.EmbedBackend
import dev.hajnina.scanlist.embed.Embedder
import dev.hajnina.scanlist.embed.EmbedderConfig
import dev.hajnina.scanlist.embed.EmbedderException
import dev.hajnina.scanlist.embed.EmbeddingUnavailableException
import dev.hajnina.scanlist.embed.Embedders
import dev.hajnina.scanlist.embed.LiteRtEmbedder
import dev.hajnina.scanlist.embed.NoBackendException
import dev.hajnina.scanlist.embed.Prompts
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.Executors

/**
 * `Embed` — the React Native bridge to the Kotlin engine every ScanList track uses (card A3).
 *
 * This is a plain `ReactContextBaseJavaModule` (not a codegen TurboModule), registered by
 * [EmbedPackage] and reached from JS through `modules/embed/index.ts`. On the new architecture RN 0.88
 * runs it through the legacy-module interop layer (`ReactNativeNewArchitectureFeatureFlagsDefaults
 * .useTurboModuleInterop()` is true for new arch + bridgeless), so the JS side sees one TurboModule
 * called `Embed` with the methods below. Why not codegen: codegen config lives in a package-level
 * `codegenConfig` / autolinked RN library, i.e. outside this card's `owns`; the bridge surface here is
 * five methods and gains nothing from a generated spec. Card A6 or the lead can migrate it once the
 * module becomes a real `apps/rn/modules/embed` autolinked package.
 *
 * Threading: `shared/android-embed` is blocking and single-instance (the LiteRT-LM engine is not
 * thread-safe), so every call is serialised on one worker thread; the JS thread never blocks. The
 * first call also loads + self-tests the model (CPU 1-2 s, GPU 3-8 s, RECIPE.md §6) — its `openMs` in
 * the result says how much of `latencyMs` was the load.
 *
 * Vectors: base64 of little-endian float32 (see [EmbedVectors]) — no JSON array of numbers.
 * Errors: rejected with a stable `code` (`E_MODEL_MISSING`, `E_NO_BACKEND`, `E_UNAVAILABLE`,
 * `E_INPUT`, `E_IMAGE`, `E_EMBED`) that `modules/embed/index.ts` re-throws as an `EmbedError`.
 */
class EmbedModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val worker =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, THREAD_NAME).apply { isDaemon = true }
        }

    private val engineLock = Any()

    @Volatile private var engine: Embedder? = null

    /** Model-open cost the *next* result should report: set when the ladder runs, consumed once. */
    @Volatile private var pendingOpenMs: Double = 0.0

    /**
     * Card A6 settings picker: null = the shipped ladder (GPU → CPU); a list = that exact order.
     * Set by [setBackend], consumed by [engine] on the next open. Strict choices must fail honestly
     * rather than silently measuring another backend.
     */
    @Volatile private var backendOrder: List<EmbedBackend>? = null

    /** `prompts.json` `dims.active` (256 today) without opening the model; the library's default on failure. */
    private val specDims: Int by lazy {
        runCatching { Prompts.load(reactApplicationContext).activeDims }
            .getOrDefault(Embedder.DEFAULT_DIMS)
    }

    override fun getName(): String = NAME

    override fun getConstants(): Map<String, Any> {
        val current = engine
        return mapOf(
            "name" to ENGINE_NAME,
            "modelId" to EmbedderConfig.DEFAULT_MODEL_ID,
            "dims" to (current?.dims ?: specDims),
            "backend" to (current?.backend ?: Embedder.BACKEND_NONE),
            "modelFile" to EmbedModel.FILE_NAME,
            "modelPresent" to (EmbedModel.find(reactApplicationContext) != null),
            "supportsImages" to (current?.supportsImages ?: false),
            "linked" to true,
        )
    }

    /**
     * Embeds shopping-list items (doc prefix). Resolves
     * `{vectors: string[] (base64 float32), dims: number, backend: string, latencyMs: number, openMs: number}`.
     */
    @ReactMethod
    fun embedDocs(texts: ReadableArray, promise: Promise) {
        // ReadableArray is only valid on the calling thread: copy before hopping to the worker.
        val input = ArrayList<String>(texts.size())
        for (i in 0 until texts.size()) {
            input.add(texts.getString(i) ?: "")
        }
        run(promise) {
            if (input.isEmpty()) {
                throw BadInputException("embedDocs needs at least one text")
            }
            // Open first, so `latencyMs` is the inference alone and `openMs` carries the model load.
            val embedder = engine()
            val started = SystemClock.elapsedRealtime()
            val vectors = embedder.embedDocs(input)
            val latency = (SystemClock.elapsedRealtime() - started).toDouble()
            Arguments.createMap().apply {
                putArray("vectors", vectorArray(vectors))
                putInt("dims", vectors.firstOrNull()?.size ?: engine()?.dims ?: specDims)
                putString("backend", backendId())
                putDouble("latencyMs", latency)
                putDouble("openMs", takeOpenMs())
            }
        }
    }

    /** Embeds one scan query (query prefix). Resolves one `{vector, dims, backend, latencyMs, openMs}`. */
    @ReactMethod
    fun embedQuery(text: String, promise: Promise) {
        run(promise) {
            if (text.isBlank()) {
                throw BadInputException("embedQuery needs a non-blank text")
            }
            val embedder = engine()
            val started = SystemClock.elapsedRealtime()
            val vector = embedder.embedQuery(text)
            val latency = (SystemClock.elapsedRealtime() - started).toDouble()
            singleResult(vector, latency)
        }
    }

    /**
     * Embeds a JPEG camera frame (no prefix). Give exactly one of [base64] (raw JPEG bytes, base64) or
     * [uri] (`file://`, `content://`, or a plain path). Resolves one `{vector, dims, backend, latencyMs, openMs}`.
     */
    @ReactMethod
    fun embedImage(base64: String?, uri: String?, promise: Promise) {
        run(promise) {
            val jpeg = readImage(base64, uri)
            val embedder = engine()
            val started = SystemClock.elapsedRealtime()
            val vector = embedder.embedImage(jpeg)
            val latency = (SystemClock.elapsedRealtime() - started).toDouble()
            singleResult(vector, latency)
        }
    }

    /**
     * Model/engine state without opening the model: `{backend, dims, supportsImages, modelId,
     * modelPresent, modelPath, open}`. Never rejects for a missing model — that is a state, not an error.
     *
     * Card A6 added the settings screen's facts: the bundle's byte size and readability, the pinned
     * sha256 as a display label, and the active prefix set from `prompts.json` (never recomputed here:
     * a 484 MB hash per settings visit would be dishonest about "instant").
     */
    @ReactMethod
    fun status(promise: Promise) {
        run(promise) {
            val current = engine
            val model = EmbedModel.find(reactApplicationContext)
            Arguments.createMap().apply {
                putString("backend", current?.backend ?: Embedder.BACKEND_NONE)
                putInt("dims", current?.dims ?: specDims)
                putBoolean("supportsImages", current?.supportsImages ?: false)
                putString("modelId", current?.modelId ?: EmbedderConfig.DEFAULT_MODEL_ID)
                putBoolean("modelPresent", model != null)
                putString(
                    "modelPath",
                    model?.absolutePath ?: EmbedModel.candidates(reactApplicationContext).first().absolutePath,
                )
                putString("modelFile", EmbedModel.FILE_NAME)
                putBoolean("open", current != null)
                putString("hint", EmbedModel.pushHint(reactApplicationContext))
                putDouble("modelBytes", (model?.length() ?: 0L).toDouble())
                putBoolean("modelReadable", model?.canRead() == true)
                putString("modelSha256", EmbedderConfig.DEFAULT_MODEL_SHA256)
                promptsMap()?.let { putMap("prompts", it) }
            }
        }
    }

    /**
     * Card A6: persist the settings picker's backend policy and unload the engine, so the next call
     * opens on exactly that ladder. `auto` restores the shipped GPU → CPU fallback; `gpu`/`cpu`/`npu`
     * are strict; `npu` is experimental (RECIPE.md §7).
     */
    @ReactMethod
    fun setBackend(choice: String, promise: Promise) {
        run(promise) {
            backendOrder = orderFor(choice)
            engine?.close()
            engine = null
            pendingOpenMs = 0.0
            null
        }
    }

    /**
     * Card A6: delete one of the scanner's temp JPEGs (the capture loop writes ~100-200 KB per
     * sampled frame). This is the bridge's only filesystem verb, and it refuses anything outside the
     * app cache, so it cannot be used to delete arbitrary files.
     */
    @ReactMethod
    fun deleteTempFile(path: String, promise: Promise) {
        run(promise) {
            val cacheRoot = reactApplicationContext.cacheDir.canonicalFile
            val file = File(path).canonicalFile
            if (!file.path.startsWith(cacheRoot.path + File.separator)) {
                throw BadInputException("deleteTempFile refuses a path outside the app cache: $path")
            }
            val deleted = !file.exists() || file.delete()
            Arguments.createMap().apply {
                putBoolean("deleted", deleted)
                putString("path", file.path)
            }
        }
    }

    /** Unloads the model (the next call reopens it through the GPU → CPU ladder). */
    @ReactMethod
    fun close(promise: Promise) {
        run(promise) {
            engine?.close()
            engine = null
            pendingOpenMs = 0.0
            null
        }
    }

    override fun invalidate() {
        // Card A6 (A4/A3 review nit): close through the worker queue, not from the caller's thread.
        // `engine()` only runs on the worker, so enqueueing the close serialises it after any in-flight
        // embed instead of pulling the native engine out from under it. `shutdown()` lets the queued
        // close run, then refuses further work.
        val current = engine
        engine = null
        pendingOpenMs = 0.0
        if (current != null) {
            runCatching {
                worker.execute { runCatching { current.close() } }
            }
        }
        worker.shutdown()
        super.invalidate()
    }

    // ---------------------------------------------------------------- internals

    /** Serialises [block] on the worker thread and turns its outcome into a bridge promise. */
    private fun run(promise: Promise, block: () -> WritableMap?) {
        worker.execute {
            try {
                promise.resolve(block())
            } catch (t: Throwable) {
                promise.reject(codeOf(t), messageOf(t), t)
            }
        }
    }

    /** The one embedder of this process, opened (model load + self-test) on first use. */
    private fun engine(): Embedder {
        engine?.let { return it }
        synchronized(engineLock) {
            engine?.let { return it }
            val model = EmbedModel.find(reactApplicationContext)
                ?: throw ModelMissingException(
                    "no ${EmbedModel.FILE_NAME} in ${EmbedModel.candidates(reactApplicationContext).joinToString(", ") { it.absolutePath }} " +
                        "— provision it with: ${EmbedModel.pushHint(reactApplicationContext)}",
                )
            val order = backendOrder
            val started = SystemClock.elapsedRealtime()
            val created = Embedders.create(
                reactApplicationContext,
                EmbedderConfig(
                    modelFile = model,
                    backendOrder = order,
                    allowNpu = order?.contains(EmbedBackend.NPU) == true,
                ),
            )
            // create() only reads the bundled prompts/golden assets; the ladder (and the 484 MB
            // model load + self-test) runs on the first embed. `open()` does that now, on the worker
            // thread, so `openMs` can report it separately from the first call's `latencyMs`.
            try {
                (created as? LiteRtEmbedder)?.open()
            } catch (t: Throwable) {
                // Card A6 (A3 review nit): a failed open must not leak the engine it built, or the
                // retry would hold two ~0.5 GB native engines. Close it before rethrowing.
                runCatching { created.close() }
                pendingOpenMs = 0.0
                throw t
            }
            pendingOpenMs = (SystemClock.elapsedRealtime() - started).toDouble()
            engine = created
            return created
        }
    }

    /**
     * The settings picker's id → the exact ladder to try. Unknown ids are rejected rather than
     * silently mapped, so a typo in the JS layer is visible (the picker only sends these four).
     */
    private fun orderFor(choice: String): List<EmbedBackend>? =
        when (choice.trim().lowercase()) {
            "auto" -> null // shipped ladder: GPU → CPU
            "gpu" -> listOf(EmbedBackend.GPU)
            "cpu" -> listOf(EmbedBackend.CPU)
            "npu" -> listOf(EmbedBackend.NPU)
            else -> throw BadInputException(
                "setBackend expects auto|gpu|cpu|npu, got '$choice'",
            )
        }

    /** The active prefix set from the bundled prompts.json, or null when the asset is unusable. */
    private fun promptsMap(): WritableMap? =
        runCatching { Prompts.load(reactApplicationContext) }.getOrNull()?.let { prompts ->
            Arguments.createMap().apply {
                putString("active", prompts.active)
                putInt("version", prompts.version)
                putString("model", prompts.model)
                putString("doc", prompts.docPrefix)
                putString("query", prompts.queryPrefix)
                putString("image", prompts.imagePrefix)
                putInt("dims", prompts.activeDims)
                putInt("nativeDims", prompts.nativeDims)
            }
        }

    private fun backendId(): String = engine?.backend ?: Embedder.BACKEND_NONE

    /** The open cost once, for the call that paid it; 0 for every call after. */
    private fun takeOpenMs(): Double {
        val ms = pendingOpenMs
        pendingOpenMs = 0.0
        return ms
    }

    private fun singleResult(vector: FloatArray, latencyMs: Double): WritableMap =
        Arguments.createMap().apply {
            putString("vector", EmbedVectors.toBase64(vector))
            putInt("dims", vector.size)
            putString("backend", backendId())
            putDouble("latencyMs", latencyMs)
            putDouble("openMs", takeOpenMs())
        }

    private fun vectorArray(vectors: List<FloatArray>): WritableArray =
        Arguments.createArray().apply {
            for (vector in vectors) {
                pushString(EmbedVectors.toBase64(vector))
            }
        }

    private fun readImage(base64: String?, uri: String?): ByteArray {
        val bytes =
            when {
                !base64.isNullOrBlank() -> AndroidBase64.decode(base64, AndroidBase64.DEFAULT)
                !uri.isNullOrBlank() -> readUri(uri)
                else -> throw BadInputException("embedImage needs {base64} or {uri}")
            }
        if (bytes.isEmpty()) {
            throw BadInputException("embedImage got an empty image")
        }
        return bytes
    }

    private fun readUri(uri: String): ByteArray {
        val parsed = Uri.parse(uri)
        return when (parsed.scheme) {
            "content", "android.resource" -> {
                val stream = reactApplicationContext.contentResolver.openInputStream(parsed)
                    ?: throw BadInputException("embedImage cannot open $uri")
                stream.use { it.readBytes() }
            }
            "file" -> File(parsed.path ?: throw BadInputException("embedImage: $uri has no path")).readBytes()
            null -> File(uri).readBytes()
            else -> throw BadInputException("embedImage: unsupported uri scheme '${parsed.scheme}' ($uri)")
        }
    }

    private fun codeOf(t: Throwable): String =
        when (t) {
            is ModelMissingException -> "E_MODEL_MISSING"
            is NoBackendException -> "E_NO_BACKEND"
            is EmbeddingUnavailableException -> "E_UNAVAILABLE"
            is BadInputException -> "E_INPUT"
            is FileNotFoundException -> "E_IMAGE"
            is EmbedderException -> "E_EMBED"
            else -> "E_EMBED"
        }

    private fun messageOf(t: Throwable): String =
        t.message?.takeIf { it.isNotBlank() }
            ?: "${t.javaClass.simpleName} (no message)"

    companion object {
        const val NAME = "Embed"

        /** `Embedder.name` in the cross-track contract: this is the shared Kotlin engine, not a model. */
        const val ENGINE_NAME = "android-embed"

        private const val THREAD_NAME = "scanlist-embed"
    }
}

/** The model file is not on the device (expected until card B0/S6 provisions one). */
internal class ModelMissingException(message: String) : Exception(message)

/** The JS caller passed something the module cannot use (blank text, no image, empty list). */
internal class BadInputException(message: String) : Exception(message)
