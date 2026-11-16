package dev.hajnina.scanlist.embed

/**
 * Test doubles for [EmbedEngine] / [EngineFactory] (card S5): the JVM tests run the whole ladder and
 * self-test without LiteRT-LM, a model file or a device. No Android class is touched.
 */
internal class FakeEngine(
    override val modelInfo: EngineModelInfo = EngineModelInfo(maxContextTokens = 2048, vision = true),
    private val onImage: (ByteArray) -> FloatArray = { FloatArray(4) },
    private val onText: (String) -> FloatArray,
) : EmbedEngine {
    val textCalls = mutableListOf<String>()
    val imageCalls = mutableListOf<ByteArray>()
    val imageVisionTokens = mutableListOf<Int>()
    var closed = 0

    override fun embedText(prefixed: String, outputSize: Int): FloatArray {
        textCalls += prefixed
        return onText(prefixed)
    }

    override fun embedImage(jpeg: ByteArray, outputSize: Int, visionTokensPerImage: Int): FloatArray {
        imageCalls += jpeg
        imageVisionTokens += visionTokensPerImage
        return onImage(jpeg)
    }

    override fun close() {
        closed++
    }
}

internal class FakeEngineFactory(private val engineFor: (EmbedBackend) -> EmbedEngine) : EngineFactory {
    val opened = mutableListOf<EmbedBackend>()

    override fun open(backend: EmbedBackend): EmbedEngine {
        opened += backend
        return engineFor(backend)
    }
}

/** A minimal `prompts.json` for tests: 4-dim self-test vectors, no image prefix. */
internal val TEST_PROMPTS = Prompts(
    version = 1,
    model = "fake-embed",
    nativeDims = 4,
    activeDims = 4,
    matryoshka = listOf(4),
    imagePrefix = "",
    active = "modelcard",
    queryPrefix = "Q|",
    docPrefix = "D|",
)

/** The self-test inputs as this test's prefixes produce them. */
internal val TEST_QUERY = TEST_PROMPTS.query(GoldenVectors.QUERY)
internal val TEST_RELATED = TEST_PROMPTS.doc(GoldenVectors.RELATED)
internal val TEST_UNRELATED = TEST_PROMPTS.doc(GoldenVectors.UNRELATED)

/** q=[1,0,0,0], related=[0.9,0.1,0,0], unrelated=[0,1,0,0]: related wins, as the model should. */
internal val TEST_Q = floatArrayOf(1f, 0f, 0f, 0f)
internal val TEST_RELATED_VEC = floatArrayOf(0.9f, 0.1f, 0f, 0f)
internal val TEST_UNRELATED_VEC = floatArrayOf(0f, 1f, 0f, 0f)

internal fun testGolden(
    query: FloatArray = TEST_Q,
    related: FloatArray = TEST_RELATED_VEC,
    unrelated: FloatArray = TEST_UNRELATED_VEC,
): GoldenVectors = GoldenVectors(
    sha256 = "test",
    vectors = mapOf("query" to query, "related" to related, "unrelated" to unrelated),
)

internal fun testEngine(
    docVector: FloatArray = floatArrayOf(0.5f, 0.5f, 0f, 0f),
    queryVector: FloatArray = TEST_Q,
    relatedVector: FloatArray = TEST_RELATED_VEC,
    unrelatedVector: FloatArray = TEST_UNRELATED_VEC,
    imageVector: FloatArray = floatArrayOf(0f, 0f, 3f, 4f),
    info: EngineModelInfo = EngineModelInfo(maxContextTokens = 2048, vision = true),
): FakeEngine = FakeEngine(info, onText = { prefixed ->
    when (prefixed) {
        TEST_QUERY -> queryVector
        TEST_RELATED -> relatedVector
        TEST_UNRELATED -> unrelatedVector
        else -> docVector
    }
}, onImage = { imageVector })

internal fun testEmbedder(
    factory: EngineFactory,
    health: BackendHealth = BackendHealth("fake-embed", InMemoryBackendStore()),
    prompts: Prompts = TEST_PROMPTS,
    golden: GoldenVectors? = testGolden(),
    config: EmbedderConfig = EmbedderConfig(
        modelFile = java.io.File("/tmp/fake.litertlm"),
        modelId = "fake-embed",
        modelSha256 = null,
        nativeDims = 4,
        backendOrder = listOf(EmbedBackend.GPU, EmbedBackend.CPU),
    ),
    log: BackendLadder.Logger = BackendLadder.Logger.NONE,
): LiteRtEmbedder = LiteRtEmbedder(config, prompts, golden, factory, health, log)
