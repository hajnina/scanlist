package dev.hajnina.scanlist.kotlin.settings

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The thin Compose state holder: the picker persists its choice and every switch clears the old
 * measurement (so the latency card can never show a number from a different backend), and the model
 * status follows the file. No device: the runner is the fake-clock one from [SelfTestRunnerTest].
 */
class SettingsStateTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val prefixes = PrefixInfo(
        active = "mnemothera",
        version = 1,
        model = "embeddinggemma-2-740m",
        docPrefix = "task: search result | text: ",
        queryPrefix = "task: search query | text: ",
        imagePrefix = "",
        dims = 256,
        nativeDims = 768,
    )

    private fun state(
        model: File = File(temp.root, "models/embeddinggemma-2-740m.litertlm"),
        store: SettingsStore = SettingsStore(temp.root),
        prefixesProvider: () -> PrefixInfo = { prefixes },
    ): SettingsState {
        val clock = FakeClock()
        val runner = SelfTestRunner(openEmbedder = { FakeEmbedder(clock = clock) }, nanoTime = clock::now)
        return SettingsState(model, store, runner, prefixesProvider)
    }

    @Test
    fun `the persisted choice and the prefix set are read at construction`() {
        SettingsStore(temp.root).setBackend(BackendChoice.CPU)
        val state = state()
        assertEquals(BackendChoice.CPU, state.choice)
        assertEquals(prefixes, state.prefixes)
        assertNull(state.prefixError)
        assertEquals(ProbePhase.IDLE, state.phase)
        assertNull(state.result)
    }

    @Test
    fun `selecting a backend persists it and drops the previous measurement`() {
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val state = state(model = model)
        runBlocking { state.run() }
        assertTrue(state.result is SelfTestResult.Ok)
        assertEquals(ProbePhase.DONE, state.phase)

        state.select(BackendChoice.NPU)

        assertEquals(BackendChoice.NPU, state.choice)
        assertEquals(BackendChoice.NPU, SettingsStore(temp.root).backend())
        assertNull("a stale latency must not survive a backend switch", state.result)
        assertEquals(ProbePhase.IDLE, state.phase)
    }

    @Test
    fun `selecting the already selected backend is a no-op`() {
        val state = state()
        val token = state.runToken
        state.select(BackendChoice.AUTO) // already the default
        assertEquals(BackendChoice.AUTO, state.choice)
        assertEquals(token, state.runToken)
    }

    @Test
    fun `rerun bumps the token so the screen re-embeds on the same backend`() {
        val state = state()
        val token = state.runToken
        state.rerun()
        assertEquals(token + 1, state.runToken)
        assertNull(state.result)
        assertEquals(ProbePhase.IDLE, state.phase)
        assertEquals(BackendChoice.AUTO, state.choice)
    }

    @Test
    fun `model status is probed at construction and refreshed on demand`() {
        val model = File(temp.root, "models/embeddinggemma-2-740m.litertlm")
        val state = state(model = model)
        assertTrue(state.model is ModelStatus.Missing)
        assertEquals(model.absolutePath, state.model.path)

        model.parentFile?.mkdirs()
        model.writeBytes(ByteArray(4))
        state.refreshModel()
        assertTrue(state.model is ModelStatus.Present)
    }

    @Test
    fun `a broken prompts asset shows an error instead of crashing the screen`() {
        val state = state(prefixesProvider = { error("prompts.json: unknown prefix set 'x'") })
        assertNull(state.prefixes)
        assertEquals("prompts.json: unknown prefix set 'x'", state.prefixError)
        assertNotNull(state.choice)
    }

    @Test
    fun `a run on a missing model lands as E_NO_MODEL`() {
        val state = state()
        runBlocking { state.run() }
        val failed = state.result as SelfTestResult.Failed
        assertEquals(ModelProbe.E_NO_MODEL, failed.code)
        assertEquals(ProbePhase.DONE, state.phase)
    }

    @Test
    fun `run embeds with the stored choice, not a hardcoded default`() {
        // B6 review mutation M5 survived: a run() that always passed AUTO passed 7/7. The Ok's
        // choice mirrors what run() handed the runner, so a non-default pick must surface here.
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val state = state(model = model)
        state.select(BackendChoice.CPU)
        runBlocking { state.run() }
        assertEquals(BackendChoice.CPU, (state.result as SelfTestResult.Ok).choice)
    }

    @Test
    fun `a second run waits for the in-flight one — engines never overlap (B6 review race)`() {
        // selfTest is blocking/uncancellable; a mid-run switch cancels the LaunchedEffect coroutine
        // but NOT the in-flight selfTest. The run mutex must make the second run WAIT: engine #2 may
        // only open after engine #1 finished. Without the mutex, run #2's openEmbedder fires while
        // engine #1 is still blocked on releaseFirst (secondOpenedAt < firstReleasedAt) and two
        // ~0.5 GB engines are open at once.
        val model = temp.newFile("model.litertlm").apply { writeBytes(ByteArray(8)) }
        val firstInFlight = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        var opens = 0
        var firstReleasedAt = Long.MAX_VALUE
        var secondOpenedAt = Long.MIN_VALUE
        val clock = FakeClock()
        val runner = SelfTestRunner(
            openEmbedder = { _ ->
                opens += 1
                if (opens == 1) {
                    firstInFlight.countDown()
                    releaseFirst.await()
                    firstReleasedAt = System.nanoTime()
                } else {
                    secondOpenedAt = System.nanoTime()
                }
                FakeEmbedder(clock = clock)
            },
            nanoTime = clock::now,
        )
        val state = SettingsState(model, SettingsStore(temp.root), runner, { prefixes })

        runBlocking {
            val background = launch(Dispatchers.IO) { state.run() }
            assertTrue(firstInFlight.await(5, TimeUnit.SECONDS))
            thread(isDaemon = true) {
                Thread.sleep(200)
                releaseFirst.countDown()
            }
            state.run() // blocks until run #1 releases the mutex, then re-embeds
            background.join()
        }

        assertEquals(2, opens)
        assertTrue(
            "engine #2 opened while engine #1 was still blocked — runs overlap",
            secondOpenedAt >= firstReleasedAt,
        )
        assertEquals(ProbePhase.DONE, state.phase)
        assertTrue(state.result is SelfTestResult.Ok)
    }
}
