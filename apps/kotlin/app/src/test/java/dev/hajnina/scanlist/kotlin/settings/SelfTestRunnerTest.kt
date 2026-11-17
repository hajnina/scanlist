package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.EmbedBackend
import dev.hajnina.scanlist.embed.EmbedderConfig
import dev.hajnina.scanlist.embed.NoBackendException
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Card B6 Done-when, JVM half: "switching backend re-embeds and shows new latency". The runner is the
 * re-embed step — it opens the picked backend, warms up, then embeds the three fixed samples and
 * reports per-call + mean. Every branch is covered with a fake embedder and a fake clock.
 */
class SelfTestRunnerTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `ok run reports per-call latency, mean, engine load and the real backend`() {
        val clock = FakeClock()
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val fake = FakeEmbedder(clock = clock, backend = "gpu", loadMillis = 100, callMillis = 20)
        val runner = SelfTestRunner(openEmbedder = { fake }, nanoTime = clock::now)

        val result = runner.selfTest(BackendChoice.AUTO, model)

        val ok = result as SelfTestResult.Ok
        assertEquals(BackendChoice.AUTO, ok.choice)
        assertEquals("gpu", ok.report.backend)
        assertEquals(3, ok.report.samples.size)
        assertTrue(ok.report.samples.all { it.millis == 20L })
        assertEquals(20.0, ok.report.meanMillis, 0.0001)
        assertEquals(100L, ok.report.loadMillis)
        assertTrue(ok.report.supportsImages)

        // The warm-up + exactly the three fixed samples were embedded, in order.
        assertEquals(listOf("warm-up") + SelfTestRunner.SAMPLE_TEXTS, fake.embedded)
        assertEquals(
            listOf(
                "milk",
                "sourdough bread; pan de masa madre; Bakery",
                "cherry tomatoes; tomates cherry; Produce > Vegetables",
            ),
            ok.report.samples.map { it.text },
        )

        // One resident model: the probe closes what it opened.
        assertTrue(fake.closed)
    }

    @Test
    fun `switching the choice re-opens with the new ladder and reports the new backend`() {
        val clock = FakeClock()
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val opened = mutableListOf<EmbedderConfig>()
        val fakes = mutableListOf<FakeEmbedder>()
        var fakeBackend = "gpu"
        var callMillis = 35L

        // ONE runner, reused — production reuses the remembered runner (B6 review: the old version
        // built a FRESH runner per selfTest, so a memoizing mutant passed 8/8; this wiring must bite).
        val runner = SelfTestRunner(
            openEmbedder = { config ->
                opened += config
                FakeEmbedder(clock = clock, backend = fakeBackend, callMillis = callMillis)
                    .also { fakes += it }
            },
            nanoTime = clock::now,
        )

        val gpu = runner.selfTest(BackendChoice.GPU, model) as SelfTestResult.Ok
        fakeBackend = "cpu"
        callMillis = 90L
        val cpu = runner.selfTest(BackendChoice.CPU, model) as SelfTestResult.Ok

        assertEquals("gpu", gpu.report.backend)
        assertEquals(35.0, gpu.report.meanMillis, 0.0001)
        assertEquals("cpu", cpu.report.backend)
        assertEquals(90.0, cpu.report.meanMillis, 0.0001)

        // Two opens with the two ladders, each engine embedded warm-up + the three samples,
        // and each probe closed what it opened — through the SAME runner.
        assertEquals(listOf(listOf(EmbedBackend.GPU), listOf(EmbedBackend.CPU)), opened.map { it.backendOrder })
        assertEquals(2, fakes.size)
        assertTrue(fakes.all { it.embedded.size == 1 + SelfTestRunner.SAMPLE_TEXTS.size })
        assertTrue(fakes.all { it.closed })
    }

    @Test
    fun `npu is strict and opt-in in the config it opens`() {
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        var seen: EmbedderConfig? = null
        val runner = SelfTestRunner(
            openEmbedder = { config -> seen = config; FakeEmbedder(backend = "npu") },
            nanoTime = FakeClock()::now,
        )
        runner.selfTest(BackendChoice.NPU, model)
        assertEquals(listOf(EmbedBackend.NPU), seen!!.backendOrder)
        assertTrue(seen!!.allowNpu)
    }

    @Test
    fun `missing model fails with E_NO_MODEL and never opens an embedder`() {
        var opened = false
        val runner = SelfTestRunner(
            openEmbedder = { opened = true; FakeEmbedder() },
            nanoTime = FakeClock()::now,
        )

        val result = runner.selfTest(BackendChoice.AUTO, File(temp.root, "missing.litertlm"))

        val failed = result as SelfTestResult.Failed
        assertEquals(ModelProbe.E_NO_MODEL, failed.code)
        assertEquals(BackendChoice.AUTO, failed.choice)
        assertTrue(failed.message.startsWith(ModelProbe.E_NO_MODEL))
        assertEquals(false, opened)
    }

    @Test
    fun `an empty model file is reported as unreadable under E_NO_MODEL`() {
        val empty = temp.newFile("model.litertlm") // 0 bytes
        val result = SelfTestRunner(openEmbedder = { FakeEmbedder() }, nanoTime = FakeClock()::now)
            .selfTest(BackendChoice.CPU, empty) as SelfTestResult.Failed
        assertEquals(ModelProbe.E_NO_MODEL, result.code)
        assertTrue(result.message.contains("empty"))
    }

    @Test
    fun `a failed ladder is reported with its reasons, not thrown`() {
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val runner = SelfTestRunner(
            openEmbedder = {
                throw NoBackendException(
                    candidates = listOf("gpu"),
                    reasons = listOf("gpu: IllegalArgumentException: SM8750 bundle rejected"),
                )
            },
            nanoTime = FakeClock()::now,
        )

        val failed = runner.selfTest(BackendChoice.GPU, model) as SelfTestResult.Failed
        assertEquals(SelfTestResult.E_NO_BACKEND, failed.code)
        assertEquals(listOf("gpu: IllegalArgumentException: SM8750 bundle rejected"), failed.reasons)
        assertTrue(failed.message.contains("No embedding backend"))
    }

    @Test
    fun `an embed failure is reported as E_EMBEDDER and the embedder is still closed`() {
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val fake = FakeEmbedder(failure = { IllegalStateException("kaboom") })
        val runner = SelfTestRunner(openEmbedder = { fake }, nanoTime = FakeClock()::now)

        val failed = runner.selfTest(BackendChoice.CPU, model) as SelfTestResult.Failed
        assertEquals(SelfTestResult.E_EMBEDDER, failed.code)
        assertTrue(failed.message.contains("kaboom"))
        assertTrue(fake.closed)
    }

    @Test
    fun `the model id flows into the embedder config`() {
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        var seen: EmbedderConfig? = null
        SelfTestRunner(
            openEmbedder = { config -> seen = config; FakeEmbedder() },
            nanoTime = FakeClock()::now,
        ).selfTest(BackendChoice.AUTO, model, modelId = "embeddinggemma-2-740m")

        assertEquals(EmbedderConfig.DEFAULT_MODEL_ID, seen!!.modelId)
        assertEquals(model, seen!!.modelFile)
    }
}
