package dev.hajnina.scanlist.embed

import android.content.Context
import java.io.File

/**
 * The default [Embedder] (card S5): in-process, LiteRT-LM, one engine at a time, with the GPU → CPU
 * fallback ladder and the golden-vector self-test in front of every backend.
 *
 * Behaviour, in order:
 *
 *  1. first use (or [open]) runs [BackendLadder] over [EmbedderConfig.candidates] — GPU, then CPU;
 *  2. every candidate is constructed, initialised and **proven** by [SelfTest] (ranking + cosine ≥ 0.98
 *     against the CPU reference vectors). A backend that fails any step takes a strike in
 *     [BackendHealth]; two strikes block a never-proven GPU on this device, and "blocked" still means
 *     the CPU is tried (it is never blocked);
 *  3. text gets its prefix from `prompts.json`, images get none; every vector is Matryoshka-truncated to
 *     [dims] and L2-normalised, so callers compare with a dot product;
 *  4. [close] unloads the engine and clears the strikes of a GPU/NPU that survived its work.
 *
 * This class deliberately knows nothing about Android or LiteRT-LM types: it takes [EngineFactory],
 * [Prompts], [GoldenVectors] and [BackendHealth] as constructor arguments, which is what lets the JVM
 * unit tests run the whole ladder with a fake engine. Use [create] on a device.
 *
 * Blocking and serialised: call from a background thread. Keep one instance per process (one model
 * resident at a time; RECIPE.md §7.4).
 */
class LiteRtEmbedder(
    private val config: EmbedderConfig,
    private val prompts: Prompts,
    private val golden: GoldenVectors?,
    private val engineFactory: EngineFactory,
    private val health: BackendHealth,
    private val log: BackendLadder.Logger = BackendLadder.Logger.NONE,
) : Embedder {

    init {
        require(config.nativeDims > 0) { "nativeDims must be positive" }
    }

    /** Matryoshka size: the config's override, else `prompts.json`'s `dims.active` (256 today). */
    override val dims: Int = config.matryoshkaDims ?: prompts.activeDims

    init {
        require(dims in 1..config.nativeDims) { "matryoshka dims $dims must be in 1..${config.nativeDims}" }
    }

    override val modelId: String get() = config.modelId

    private val ladder = BackendLadder(health, log)
    private val lock = Any()

    @Volatile
    override var backend: String = Embedder.BACKEND_NONE
        private set

    private var engine: EmbedEngine? = null
    private var info: EngineModelInfo? = null

    override val supportsImages: Boolean
        get() = synchronized(lock) { info?.vision == true }

    /**
     * Loads the engine now (blocking, see the class doc) instead of on the first embed call. Useful
     * before a settings screen shows the chosen backend or before the camera opens.
     */
    fun open() {
        synchronized(lock) { engineLocked() }
    }

    override fun embedDocs(texts: List<String>): List<FloatArray> = synchronized(lock) {
        if (texts.isEmpty()) return@synchronized emptyList()
        val e = engineLocked()
        texts.map { finish(e.embedText(prompts.doc(it), config.nativeDims)) }
    }

    override fun embedQuery(text: String): FloatArray = synchronized(lock) {
        finish(engineLocked().embedText(prompts.query(text), config.nativeDims))
    }

    override fun embedImage(jpeg: ByteArray): FloatArray = synchronized(lock) {
        require(jpeg.isNotEmpty()) { "empty JPEG" }
        val e = engineLocked()
        if (e.modelInfo.vision != true) {
            throw EmbeddingUnavailableException(
                "${config.modelId}: the loaded bundle has no vision encoder " +
                    "(ModelInfo.inputModalities().vision == false). Text embedding still works; use the " +
                    "barcode/OCR scan sources, or probe another bundle on the device (card B0).",
            )
        }
        finish(e.embedImage(jpeg, config.nativeDims, config.visionTokensPerImage))
    }

    /**
     * Truncate to the active Matryoshka size, then L2-normalise. Also validates the native output size,
     * so a wrong-dimension backend fails loudly instead of producing silently uncomparable vectors.
     */
    private fun finish(vector: FloatArray): FloatArray {
        if (vector.size != config.nativeDims) {
            throw EmbedderException("engine returned ${vector.size} dims, expected ${config.nativeDims}")
        }
        return Vectors.truncateAndNormalize(vector, dims)
    }

    /** The loaded engine, opening it through the ladder on first use. Callers hold [lock]. */
    private fun engineLocked(): EmbedEngine {
        engine?.let { return it }
        val loaded = ladder.load(
            model = config.modelId,
            candidates = config.candidates(),
            open = { backend -> engineFactory.open(backend) },
            prove = { backend, candidate -> propose(candidate, backend) },
            close = { candidate -> candidate.close() },
        )
        engine = loaded.engine
        info = loaded.engine.modelInfo
        backend = loaded.backend.id
        log.log("embedder_open", "backend=${loaded.backend.id} dims=$dims skipped=${loaded.skipped}")
        return loaded.engine
    }

    /** The ladder's proof step: the self-test, with its warning (CPU without golden vectors) logged. */
    private fun propose(candidate: EmbedEngine, backend: EmbedBackend) {
        val result = SelfTest.prove(candidate, prompts, golden, config.nativeDims, backend)
        result.warning?.let { log.log("embed_selftest_warning", it) }
        log.log("embed_selftest", "backend=${backend.id} cosines=${result.cosines}")
    }

    /**
     * Unloads the engine. A GPU/NPU that was proven and now closes cleanly has its strikes cleared — it
     * survived its work (MnemoThera's BackendGuard.unloaded rule). Safe to call twice; never blocks.
     */
    override fun close() {
        synchronized(lock) {
            val current = engine ?: return
            engine = null
            info = null
            EmbedBackend.fromId(backend)?.let { health.cleanClose(it) }
            backend = Embedder.BACKEND_NONE
            runCatching { current.close() }.onFailure { log.log("embedder_close_failed", it.toString()) }
        }
    }

    companion object {
        /**
         * The device entry point: reads the bundled `prompts.json` / `embed_golden.json`, builds the real
         * LiteRT-LM factory and a SharedPreferences-backed backend history.
         */
        fun create(context: Context, config: EmbedderConfig): LiteRtEmbedder {
            val prompts = Prompts.load(context)
            val golden = GoldenVectors.load(context, config.modelSha256)
            val factory = LiteRtEngineFactory(
                context = context,
                modelFile = config.modelFile,
                maxInputLength = config.maxInputLength,
                visionTokensPerImage = config.visionTokensPerImage,
                useFloat32Activations = config.useFloat32Activations,
            )
            val health = BackendHealth(
                modelId = config.modelId,
                store = SharedPreferencesBackendStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)),
            )
            return LiteRtEmbedder(config, prompts, golden, factory, health)
        }

        /** SharedPreferences file for the per-device backend history. */
        const val PREFS = "scanlist_embed"

        /** The model file the app is expected to provision under its own files dir (card S6). */
        fun defaultModelFile(context: Context, modelId: String = EmbedderConfig.DEFAULT_MODEL_ID): File =
            File(context.getExternalFilesDir(null), "models/$modelId/$modelId.litertlm")
    }
}
