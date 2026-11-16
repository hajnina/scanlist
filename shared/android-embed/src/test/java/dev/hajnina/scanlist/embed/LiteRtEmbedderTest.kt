package dev.hajnina.scanlist.embed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.sqrt

/**
 * The whole in-process embedder against a fake engine (card S5): prefixes, Matryoshka truncation,
 * L2 normalisation, the golden self-test, the GPU → CPU ladder with its strikes, image handling and
 * the clean-close rule — none of it needs LiteRT-LM, a model file or a device.
 */
class LiteRtEmbedderTest {

    // --- text pipeline: prefix, truncate, normalise ------------------------------------------------

    private val prompts8 = TEST_PROMPTS.copy(nativeDims = 8, activeDims = 4, matryoshka = listOf(8, 4))
    private val q8 = floatArrayOf(1f, 0f, 0f, 0f, 0f, 0f, 0f, 0f)
    private val related8 = floatArrayOf(0.9f, 0.1f, 0f, 0f, 0f, 0f, 0f, 0f)
    private val unrelated8 = floatArrayOf(0f, 1f, 0f, 0f, 0f, 0f, 0f, 0f)
    private val doc8 = floatArrayOf(3f, 4f, 5f, 6f, 7f, 8f, 9f, 10f)
    private val golden8 = GoldenVectors("test", mapOf("query" to q8, "related" to related8, "unrelated" to unrelated8))

    private fun engine8() = FakeEngine(modelInfo = EngineModelInfo(maxContextTokens = 4096, vision = true), onText = { prefixed ->
        when (prefixed) {
            prompts8.query(GoldenVectors.QUERY) -> q8
            prompts8.doc(GoldenVectors.RELATED) -> related8
            prompts8.doc(GoldenVectors.UNRELATED) -> unrelated8
            else -> doc8
        }
    })

    private fun embedder8(engine: FakeEngine) = LiteRtEmbedder(
        config = EmbedderConfig(
            modelFile = File("/tmp/fake.litertlm"),
            modelId = "fake-embed",
            modelSha256 = null,
            nativeDims = 8,
            backendOrder = listOf(EmbedBackend.CPU),
        ),
        prompts = prompts8,
        golden = golden8,
        engineFactory = { engine },
        health = BackendHealth("fake-embed", InMemoryBackendStore()),
    )

    @Test
    fun docEmbeddingAppliesTheSpecDocPrefix() {
        val engine = engine8()
        val embedder = embedder8(engine)
        embedder.embedDocs(listOf("  milk \t", "bread"))

        val docs = engine.textCalls.filter { it != prompts8.query(GoldenVectors.QUERY) && it != prompts8.doc(GoldenVectors.RELATED) && it != prompts8.doc(GoldenVectors.UNRELATED) }
        assertEquals(listOf(prompts8.doc("milk"), prompts8.doc("bread")), docs)
        assertEquals("prefix + trimmed text, nothing else", "D|milk", docs[0])
    }

    @Test
    fun queryEmbeddingAppliesTheSpecQueryPrefix() {
        val engine = engine8()
        val embedder = embedder8(engine)
        embedder.embedQuery("  milk ")
        assertEquals(prompts8.query("milk"), engine.textCalls.last())
        assertTrue(engine.textCalls.last().startsWith("Q|"))
    }

    @Test
    fun outputIsMatryoshkaTruncatedTo256ShapeAndL2Normalised() {
        val embedder = embedder8(engine8())
        val vector = embedder.embedDocs(listOf("milk")).single()

        assertEquals(4, vector.size)
        assertEquals(embedder.dims, vector.size)
        val norm = sqrt(86f) // 3²+4²+5²+6²
        val expected = floatArrayOf(3f / norm, 4f / norm, 5f / norm, 6f / norm)
        for (i in expected.indices) assertEquals("index $i", expected[i], vector[i], 1e-6f)
        assertEquals(1f, Vectors.norm(vector), 1e-6f)
    }

    @Test
    fun dimsComeFromPromptsUnlessTheConfigOverridesThem() {
        assertEquals(4, embedder8(engine8()).dims)
        val overridden = LiteRtEmbedder(
            config = EmbedderConfig(File("/tmp/f"), modelId = "fake-embed", modelSha256 = null, nativeDims = 8, matryoshkaDims = 2, backendOrder = listOf(EmbedBackend.CPU)),
            prompts = prompts8,
            golden = golden8,
            engineFactory = { engine8() },
            health = BackendHealth("fake-embed", InMemoryBackendStore()),
        )
        assertEquals(2, overridden.dims)
        assertEquals(2, overridden.embedDocs(listOf("milk")).single().size)
    }

    @Test
    fun anEmptyDocListDoesNotEvenOpenTheEngine() {
        val factory = FakeEngineFactory { engine8() }
        val embedder = testEmbedder(factory)
        assertEquals(emptyList<FloatArray>(), embedder.embedDocs(emptyList()))
        assertTrue("no engine should have been opened", factory.opened.isEmpty())
    }

    // --- image ------------------------------------------------------------------------------------

    @Test
    fun imageEmbeddingSendsRawJpegBytesWithNoPrefix() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3, 0xFF.toByte(), 0xD9.toByte())
        val engine = testEngine(imageVector = floatArrayOf(0f, 0f, 3f, 4f))
        val embedder = testEmbedder({ engine })
        val vector = embedder.embedImage(jpeg)

        assertEquals(1, engine.imageCalls.size)
        assertTrue("the exact JPEG bytes reach the engine", engine.imageCalls.single().contentEquals(jpeg))
        assertArrayEquals(floatArrayOf(0f, 0f, 0.6f, 0.8f), vector, 1e-6f)
        assertTrue(embedder.supportsImages)
    }

    @Test
    fun aTextOnlyBundleRefusesImagesWithAUsefulError() {
        val engine = testEngine(info = EngineModelInfo(maxContextTokens = 2048, vision = false))
        val embedder = testEmbedder({ engine })
        embedder.open()

        assertFalse(embedder.supportsImages)
        val failure = runCatching { embedder.embedImage(byteArrayOf(1, 2, 3)) }.exceptionOrNull()
        assertTrue("expected EmbeddingUnavailableException, got $failure", failure is EmbeddingUnavailableException)
        assertTrue(failure!!.message.orEmpty().contains("no vision encoder"))
        assertTrue("text still works", embedder.embedQuery("milk").isNotEmpty())
    }

    // --- the ladder -------------------------------------------------------------------------------

    @Test
    fun aGpuThatCannotOpenFallsBackToTheCpuOnTheSameCall() {
        val gpuFailure = IllegalStateException("no OpenCL library")
        val cpuEngine = testEngine()
        val factory = FakeEngineFactory { backend ->
            if (backend == EmbedBackend.GPU) throw gpuFailure else cpuEngine
        }
        val health = BackendHealth("fake-embed", InMemoryBackendStore())
        val embedder = testEmbedder(factory, health)

        val vector = embedder.embedQuery("milk")

        assertEquals(Embedder.BACKEND_CPU, embedder.backend)
        assertEquals(4, vector.size)
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)
        assertTrue(health.record(EmbedBackend.CPU)!!.everProven)
        assertEquals(listOf(EmbedBackend.GPU, EmbedBackend.CPU), factory.opened)
    }

    @Test
    fun aGpuThatReturnsWrongNumbersIsStruckAndTheCpuIsUsed() {
        // Ranking is still right (0.9 > 0), but the related vector is not the CPU reference: only the
        // golden comparison can catch this, which is the point of the self-test.
        val distortedGpu = FakeEngine(onText = { prefixed ->
            when (prefixed) {
                TEST_QUERY -> TEST_Q
                TEST_RELATED -> floatArrayOf(0.9f, 0.5f, 0f, 0f)
                TEST_UNRELATED -> TEST_UNRELATED_VEC
                else -> floatArrayOf(0.5f, 0.5f, 0f, 0f)
            }
        })
        val cpu = testEngine()
        val health = BackendHealth("fake-embed", InMemoryBackendStore())
        val embedder = testEmbedder(FakeEngineFactory { b -> if (b == EmbedBackend.GPU) distortedGpu else cpu }, health)

        embedder.open()

        assertEquals(Embedder.BACKEND_CPU, embedder.backend)
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)
        assertTrue(health.record(EmbedBackend.GPU)!!.reason.contains("self-test"))
        assertEquals("the bad GPU engine is closed, not leaked", 1, distortedGpu.closed)
    }

    @Test
    fun aWrongRankingAlsoFailsTheProof() {
        val upsideDownGpu = FakeEngine(onText = { prefixed ->
            when (prefixed) {
                TEST_QUERY -> TEST_Q
                TEST_RELATED -> TEST_UNRELATED_VEC // closer token-wise, but the unrelated one is now "related"
                TEST_UNRELATED -> TEST_RELATED_VEC
                else -> floatArrayOf(0.5f, 0.5f, 0f, 0f)
            }
        })
        val embedder = testEmbedder(FakeEngineFactory { b -> if (b == EmbedBackend.GPU) upsideDownGpu else testEngine() })
        embedder.open()
        assertEquals("the CPU carries the load", Embedder.BACKEND_CPU, embedder.backend)
    }

    @Test
    fun aBlockedGpuIsNotEvenTried() {
        val health = BackendHealth("fake-embed", InMemoryBackendStore())
        health.strike(EmbedBackend.GPU, "first failure")
        health.strike(EmbedBackend.GPU, "second failure")
        val factory = FakeEngineFactory { testEngine() }
        val embedder = testEmbedder(factory, health)

        embedder.open()

        assertEquals(Embedder.BACKEND_CPU, embedder.backend)
        assertEquals(listOf(EmbedBackend.CPU), factory.opened)
    }

    @Test
    fun withoutGoldenVectorsGpuIsRefusedButTheCpuStillLoads() {
        val gpu = testEngine()
        val cpu = testEngine()
        val health = BackendHealth("fake-embed", InMemoryBackendStore())
        val embedder = testEmbedder(FakeEngineFactory { b -> if (b == EmbedBackend.GPU) gpu else cpu }, health, golden = null)

        val events = mutableListOf<String>()
        val loggingEmbedder = LiteRtEmbedder(
            config = EmbedderConfig(File("/tmp/f"), modelId = "fake-embed", modelSha256 = null, nativeDims = 4, backendOrder = listOf(EmbedBackend.GPU, EmbedBackend.CPU)),
            prompts = TEST_PROMPTS,
            golden = null,
            engineFactory = FakeEngineFactory { b -> if (b == EmbedBackend.GPU) gpu else cpu },
            health = health,
            log = { event, detail -> events += "$event:$detail" },
        )

        loggingEmbedder.open()

        assertEquals(Embedder.BACKEND_CPU, loggingEmbedder.backend)
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)
        assertTrue(events.any { it.startsWith("embed_selftest_warning") && it.contains("no CPU reference") })
        embedder.close()
    }

    @Test
    fun whenEveryBackendFailsTheErrorNamesThem() {
        val embedder = testEmbedder(FakeEngineFactory { throw IllegalStateException("cannot load ${it.id}") })
        val failure = runCatching { embedder.embedQuery("milk") }.exceptionOrNull()
        assertTrue("expected NoBackendException, got $failure", failure is NoBackendException)
        assertEquals(listOf("gpu", "cpu"), (failure as NoBackendException).candidates)
    }

    @Test
    fun aProvenGpuIsClosedCleanlyAndItsStrikesAreCleared() {
        val health = BackendHealth("fake-embed", InMemoryBackendStore())
        health.strike(EmbedBackend.GPU, "one earlier failure")
        val gpu = testEngine()
        val embedder = LiteRtEmbedder(
            config = EmbedderConfig(File("/tmp/f"), modelId = "fake-embed", modelSha256 = null, nativeDims = 4, backendOrder = listOf(EmbedBackend.GPU)),
            prompts = TEST_PROMPTS,
            golden = testGolden(),
            engineFactory = { gpu },
            health = health,
        )

        embedder.open()
        assertEquals(Embedder.BACKEND_GPU, embedder.backend)
        assertEquals(1, health.record(EmbedBackend.GPU)!!.strikes)

        embedder.close()

        assertEquals(Embedder.BACKEND_NONE, embedder.backend)
        assertEquals(1, gpu.closed)
        assertEquals("a backend that survived its work is forgiven", 0, health.record(EmbedBackend.GPU)!!.strikes)
    }

    @Test
    fun aSecondEmbedCallDoesNotReloadTheEngine() {
        val engine = testEngine()
        val factory = FakeEngineFactory { engine }
        val embedder = testEmbedder(factory)
        embedder.embedQuery("milk")
        embedder.embedDocs(listOf("bread", "eggs"))
        embedder.embedQuery("milk again")
        assertEquals(1, factory.opened.size)
    }

    @Test
    fun candidatesRespectTheNpuFlag() {
        val file = File("/tmp/f")
        assertEquals(listOf(EmbedBackend.GPU, EmbedBackend.CPU), EmbedderConfig(file).candidates())
        assertEquals(listOf(EmbedBackend.NPU, EmbedBackend.GPU, EmbedBackend.CPU), EmbedderConfig(file, allowNpu = true).candidates())
        assertEquals(listOf(EmbedBackend.CPU), EmbedderConfig(file, backendOrder = listOf(EmbedBackend.CPU)).candidates())
    }

    private fun assertArrayEquals(expected: FloatArray, actual: FloatArray, delta: Float) {
        assertEquals(expected.size, actual.size)
        for (i in expected.indices) assertEquals("index $i", expected[i], actual[i], delta)
    }
}
