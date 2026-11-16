package dev.hajnina.scanlist.embed

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Message
import android.os.Messenger
import android.util.Log
import java.io.File

/**
 * Hosts one [LiteRtEmbedder] in its own process (`android:process=":embed"`, declared in this module's
 * manifest) for the opt-in [RemoteEmbedder] mode (card S5).
 *
 * All work happens on a private `HandlerThread`, never on the main thread; the model load (seconds to
 * minutes) therefore never blocks the app's UI process. A native crash on a GPU/NPU driver takes this
 * process down, not the caller: the client sees the connection drop and can rebuild on the CPU.
 *
 * The service is only bound (no start), and it is not exported.
 */
class EmbedService : Service() {

    private lateinit var thread: HandlerThread
    private lateinit var messenger: Messenger

    /** Created lazily on this service's worker thread; one model resident at a time. */
    private var embedder: Embedder? = null
    private var configError: String? = null

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("embed-ipc").apply { start() }
        messenger = Messenger(Handler(thread.looper) { message -> handle(message); true })
    }

    override fun onBind(intent: Intent?): IBinder? {
        // onBind runs on the main thread; building the config is cheap, opening the engine happens on
        // the first request, on the worker thread.
        if (intent != null) {
            runCatching { embedderFor(intent) }
                .onFailure {
                    configError = "${it.javaClass.simpleName}: ${it.message}"
                    Log.e(TAG, "embed service configuration failed", it)
                }
        }
        return messenger.binder
    }

    override fun onDestroy() {
        runCatching { embedder?.close() }
        embedder = null
        thread.quitSafely()
        super.onDestroy()
    }

    private fun embedderFor(intent: Intent): Embedder {
        embedder?.let { return it }
        val modelPath = intent.getStringExtra(EmbedIpc.EXTRA_MODEL_PATH)
            ?: throw IllegalArgumentException("missing ${EmbedIpc.EXTRA_MODEL_PATH}")
        val config = EmbedderConfig(
            modelFile = File(modelPath),
            modelId = intent.getStringExtra(EmbedIpc.EXTRA_MODEL_ID) ?: EmbedderConfig.DEFAULT_MODEL_ID,
            modelSha256 = intent.getStringExtra(EmbedIpc.EXTRA_MODEL_SHA256) ?: EmbedderConfig.DEFAULT_MODEL_SHA256,
            nativeDims = intent.getIntExtra(EmbedIpc.EXTRA_NATIVE_DIMS, 768),
            matryoshkaDims = intent.getIntExtra(EmbedIpc.EXTRA_MATRYOSHKA_DIMS, 0).takeIf { it > 0 },
            maxInputLength = intent.getIntExtra(EmbedIpc.EXTRA_MAX_INPUT_LENGTH, 2048),
            visionTokensPerImage = intent.getIntExtra(EmbedIpc.EXTRA_VISION_TOKENS, 70),
            allowNpu = intent.getBooleanExtra(EmbedIpc.EXTRA_ALLOW_NPU, false),
            useFloat32Activations = intent.getBooleanExtra(EmbedIpc.EXTRA_FLOAT32, false),
        )
        return LiteRtEmbedder.create(this, config).also { embedder = it }
    }

    private fun handle(message: Message) {
        val data = message.data ?: Bundle()
        val reply = Bundle()
        try {
            val embedder = embedder ?: throw IllegalStateException(
                "embed service has no embedder" + (configError?.let { " ($it)" } ?: " (bind with the model extras)"),
            )
            when (data.getInt(EmbedIpc.KEY_OP, 0)) {
                EmbedIpc.OP_INFO -> Unit
                EmbedIpc.OP_DOCS -> {
                    val texts = data.getStringArrayList(EmbedIpc.KEY_TEXTS)?.toList() ?: emptyList()
                    val vectors = embedder.embedDocs(texts)
                    reply.putFloatArray(EmbedIpc.KEY_FLAT, flatten(vectors))
                    reply.putIntArray(EmbedIpc.KEY_LENGTHS, vectors.map { it.size }.toIntArray())
                }
                EmbedIpc.OP_QUERY -> reply.putFloatArray(EmbedIpc.KEY_VECTOR, embedder.embedQuery(data.getString(EmbedIpc.KEY_TEXTS).orEmpty()))
                EmbedIpc.OP_IMAGE -> reply.putFloatArray(EmbedIpc.KEY_VECTOR, embedder.embedImage(data.getByteArray(EmbedIpc.KEY_JPEG) ?: ByteArray(0)))
                EmbedIpc.OP_CLOSE -> Unit // replied with the info below, closed after the reply is built
                else -> throw IllegalArgumentException("unknown op ${data.getInt(EmbedIpc.KEY_OP)}")
            }
            reply.putString(EmbedIpc.KEY_BACKEND, embedder.backend)
            reply.putInt(EmbedIpc.KEY_DIMS, embedder.dims)
            reply.putBoolean(EmbedIpc.KEY_SUPPORTS_IMAGES, embedder.supportsImages)
            reply.putString(EmbedIpc.KEY_MODEL_ID, embedder.modelId)
            if (data.getInt(EmbedIpc.KEY_OP, 0) == EmbedIpc.OP_CLOSE) {
                runCatching { embedder.close() }
                this.embedder = null
            }
        } catch (t: Throwable) {
            // The client turns this back into the same exception family (see RemoteEmbedder.throwReply).
            reply.putString(EmbedIpc.KEY_ERROR, t.message ?: t.javaClass.name)
            reply.putString(EmbedIpc.KEY_ERROR_CLASS, t.javaClass.name)
        }
        runCatching { message.replyTo?.send(Message.obtain(null, 0, reply)) }
    }

    private fun flatten(vectors: List<FloatArray>): FloatArray {
        var size = 0
        for (v in vectors) size += v.size
        val out = FloatArray(size)
        var at = 0
        for (v in vectors) {
            v.copyInto(out, at)
            at += v.size
        }
        return out
    }

    companion object {
        private const val TAG = "ScanListEmbed"
    }
}
