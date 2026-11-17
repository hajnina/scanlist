package dev.hajnina.scanlist.kotlin.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import dev.hajnina.scanlist.embed.EmbedderConfig
import dev.hajnina.scanlist.embed.Embedders
import dev.hajnina.scanlist.embed.Prompts
import dev.hajnina.scanlist.kotlin.rank.defaultModelFile
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Lifecycle of the settings self-test (idle before the first run, running, done with a result). */
enum class ProbePhase { IDLE, RUNNING, DONE }

/**
 * Thin Compose state holder for the settings screen (same shape as card B2's `ListState`): the UI
 * reads state and calls one method per action; the rules (persistence, model probing, latency maths)
 * live in the tested plain-Kotlin classes next to it.
 *
 * Re-embedding on a backend switch is the screen's `LaunchedEffect(state.choice, state.runToken)`
 * calling [run]: selecting a backend clears the old numbers, so the latency card can never show a
 * measurement taken on a different backend than the one the picker shows.
 */
class SettingsState internal constructor(
    /** The bundle the embedding pipeline opens (rank's defaultModelFile), displayed and probed. */
    val modelFile: File,
    private val store: SettingsStore,
    private val runner: SelfTestRunner,
    /** Reads the bundled prefix set; injected so tests need no Android assets. */
    private val prefixesProvider: () -> PrefixInfo,
    /** The model id cached vectors are keyed by; prompts.json's `model` on device. */
    private val modelIdProvider: () -> String = { EmbedderConfig.DEFAULT_MODEL_ID },
) {

    /** The persisted picker selection (auto by default, like the shipped ladder). */
    var choice by mutableStateOf(store.backend())
        private set

    var phase by mutableStateOf(ProbePhase.IDLE)
        private set

    var result by mutableStateOf<SelfTestResult?>(null)
        private set

    /** Bumped by [rerun] so the screen's LaunchedEffect re-embeds without changing the choice. */
    var runToken by mutableStateOf(0)
        private set

    /** The active prefix set from the bundled prompts.json, or null when the asset is unusable. */
    var prefixes by mutableStateOf<PrefixInfo?>(null)
        private set

    var prefixError by mutableStateOf<String?>(null)
        private set

    /** Model file status; re-probed on every open and after each run. */
    var model by mutableStateOf(ModelProbe.status(modelFile))
        private set

    init {
        loadPrefixes()
    }

    private fun loadPrefixes() {
        runCatching { prefixesProvider() }
            .onSuccess {
                prefixes = it
                prefixError = null
            }
            .onFailure { prefixError = it.message ?: it.javaClass.simpleName }
    }

    /** Pick a backend: persist it, drop the old measurement, and let the screen re-embed. */
    fun select(next: BackendChoice) {
        if (next == choice) return
        choice = next
        store.setBackend(next)
        result = null
        phase = ProbePhase.IDLE
    }

    /** "Test again" — same backend, fresh numbers (the engine may have been unloaded since). */
    fun rerun() {
        result = null
        phase = ProbePhase.IDLE
        runToken += 1
    }

    fun refreshModel() {
        model = ModelProbe.status(modelFile)
    }

    /**
     * Run the self-test on [choice] off the main thread. Never throws: failures land in [result] as
     * [SelfTestResult.Failed] and are rendered with their status code.
     */
    suspend fun run() {
        phase = ProbePhase.RUNNING
        val measured = withContext(Dispatchers.IO) {
            runner.selfTest(choice, modelFile, modelIdProvider())
        }
        result = measured
        phase = ProbePhase.DONE
        refreshModel()
    }
}

/**
 * Device wiring: the app files dir, the real embedder (shared/android-embed), the bundled
 * prompts.json, and the same model path the list-embedding pipeline uses, so the settings screen
 * reports the status of exactly that file.
 */
@Composable
fun rememberSettingsState(): SettingsState {
    val context = LocalContext.current
    return remember(context) {
        val appContext = context.applicationContext
        val modelFile = defaultModelFile(appContext)
        SettingsState(
            modelFile = modelFile,
            store = SettingsStore.forFilesDir(appContext.filesDir),
            runner = SelfTestRunner(openEmbedder = { config -> Embedders.create(appContext, config) }),
            prefixesProvider = {
                PrefixInfo.from(Prompts.load(appContext))
            },
            modelIdProvider = {
                // prompts.json's `model` is the identity cached vectors are keyed by (card B3).
                runCatching { Prompts.load(appContext).model }.getOrDefault(EmbedderConfig.DEFAULT_MODEL_ID)
            },
        )
    }
}
