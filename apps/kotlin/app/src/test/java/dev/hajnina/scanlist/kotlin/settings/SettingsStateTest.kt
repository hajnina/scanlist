package dev.hajnina.scanlist.kotlin.settings

import java.io.File
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
}
