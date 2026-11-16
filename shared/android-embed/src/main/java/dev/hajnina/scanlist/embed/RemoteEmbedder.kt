package dev.hajnina.scanlist.embed

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The opt-in **separate-process** [Embedder] (card S5): a client of [EmbedService], which runs the
 * same [LiteRtEmbedder] in `android:process=":embed"`. Default is [LiteRtEmbedder] in-process; this
 * exists so a driver that takes its process down (a bad GPU/Mali/Adreno kernel, an NPU runtime) kills
 * the engine process, not the shopping list — MnemoThera's reason for its `:live`/`:batch` hosts
 * (RECIPE.md §2.3), reduced to one bound service.
 *
 * Blocking: every call waits for a reply, with [timeoutMs] (the first call includes the model load;
 * a CPU load is 1-2 s and a GPU load 3-8 s per RECIPE.md §6, so 180 s is generous even on a cold
 * device, while an NPU JIT compile can still exceed it — NPU stays behind the flag).
 *
 * A dropped connection (the service process died) is not fatal: the next call rebinds and reloads.
 */
class RemoteEmbedder(
    private val context: Context,
    private val config: EmbedderConfig,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
) : Embedder {

    private val lock = Any()

    @Volatile
    private var messenger: Messenger? = null

    @Volatile
    private var connection: ServiceConnection? = null

    @Volatile
    override var backend: String = Embedder.BACKEND_NONE
        private set

    @Volatile
    override var supportsImages: Boolean = false
        private set

    override val dims: Int = config.matryoshkaDims ?: runCatching { Prompts.load(context).activeDims }.getOrDefault(Embedder.DEFAULT_DIMS)
    override val modelId: String get() = config.modelId

    override fun embedDocs(texts: List<String>): List<FloatArray> = synchronized(lock) {
        if (texts.isEmpty()) return@synchronized emptyList()
        val request = Bundle().apply {
            putInt(EmbedIpc.KEY_OP, EmbedIpc.OP_DOCS)
            putStringArrayList(EmbedIpc.KEY_TEXTS, ArrayList(texts))
        }
        val reply = request(request)
        val flat = reply.getFloatArray(EmbedIpc.KEY_FLAT) ?: FloatArray(0)
        val lengths = reply.getIntArray(EmbedIpc.KEY_LENGTHS) ?: IntArray(0)
        var at = 0
        lengths.map { length ->
            val vector = flat.copyOfRange(at, at + length)
            at += length
            vector
        }
    }

    override fun embedQuery(text: String): FloatArray = synchronized(lock) {
        val reply = request(Bundle().apply {
            putInt(EmbedIpc.KEY_OP, EmbedIpc.OP_QUERY)
            putString(EmbedIpc.KEY_TEXTS, text)
        })
        reply.getFloatArray(EmbedIpc.KEY_VECTOR) ?: throw EmbedderException("embed service returned no vector")
    }

    override fun embedImage(jpeg: ByteArray): FloatArray = synchronized(lock) {
        require(jpeg.isNotEmpty()) { "empty JPEG" }
        val reply = request(Bundle().apply {
            putInt(EmbedIpc.KEY_OP, EmbedIpc.OP_IMAGE)
            putByteArray(EmbedIpc.KEY_JPEG, jpeg)
        })
        reply.getFloatArray(EmbedIpc.KEY_VECTOR) ?: throw EmbedderException("embed service returned no vector")
    }

    /** Best effort: ask the service to unload, then drop the binding. Never throws. */
    override fun close() {
        synchronized(lock) {
            runCatching {
                messenger?.let { m ->
                    val message = Message.obtain(null, 0)
                    message.data = Bundle().apply { putInt(EmbedIpc.KEY_OP, EmbedIpc.OP_CLOSE) }
                    m.send(message)
                }
            }
            runCatching { connection?.let { context.unbindService(it) } }
            connection = null
            messenger = null
            backend = Embedder.BACKEND_NONE
            supportsImages = false
        }
    }

    /** Sends one request and waits for the reply. Callers hold [lock]. */
    private fun request(request: Bundle): Bundle {
        val m = messengerLocked()
        val replies = LinkedBlockingQueue<Bundle>(1)
        val replyHandler = Handler(Looper.getMainLooper()) { message ->
            replies.offer(message.data ?: Bundle())
            true
        }
        val message = Message.obtain(null, 0).apply {
            data = request
            replyTo = Messenger(replyHandler)
        }
        try {
            m.send(message)
        } catch (t: Throwable) {
            // The service process died between calls: drop the binding so the next call rebinds.
            dropConnection()
            throw EmbedderException("embed service is gone (${t.javaClass.simpleName}: ${t.message})", t)
        }
        val reply = replies.poll(timeoutMs, TimeUnit.MILLISECONDS)
            ?: throw EmbedderException("embed service timed out after ${timeoutMs} ms")
        reply.getString(EmbedIpc.KEY_ERROR)?.let { error ->
            throw when (reply.getString(EmbedIpc.KEY_ERROR_CLASS)) {
                EmbeddingUnavailableException::class.java.name -> EmbeddingUnavailableException(error)
                else -> EmbedderException(error)
            }
        }
        backend = reply.getString(EmbedIpc.KEY_BACKEND) ?: backend
        supportsImages = reply.getBoolean(EmbedIpc.KEY_SUPPORTS_IMAGES, supportsImages)
        return reply
    }

    /** Binds on first use and returns the service messenger. Callers hold [lock]. */
    private fun messengerLocked(): Messenger {
        messenger?.let { return it }
        val latch = CountDownLatch(1)
        val serviceConnection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                messenger = binder?.let { Messenger(it) }
                latch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                messenger = null
            }

            override fun onBindingDied(name: ComponentName?) {
                messenger = null
            }
        }
        val intent = Intent(context, EmbedService::class.java).apply {
            putExtra(EmbedIpc.EXTRA_MODEL_PATH, config.modelFile.path)
            putExtra(EmbedIpc.EXTRA_MODEL_ID, config.modelId)
            putExtra(EmbedIpc.EXTRA_MODEL_SHA256, config.modelSha256)
            putExtra(EmbedIpc.EXTRA_NATIVE_DIMS, config.nativeDims)
            putExtra(EmbedIpc.EXTRA_MATRYOSHKA_DIMS, config.matryoshkaDims ?: 0)
            putExtra(EmbedIpc.EXTRA_MAX_INPUT_LENGTH, config.maxInputLength)
            putExtra(EmbedIpc.EXTRA_VISION_TOKENS, config.visionTokensPerImage)
            putExtra(EmbedIpc.EXTRA_ALLOW_NPU, config.allowNpu)
            putExtra(EmbedIpc.EXTRA_FLOAT32, config.useFloat32Activations)
        }
        val bound = context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        if (!bound) throw EmbedderException("cannot bind ${EmbedService::class.java.name} (is it declared in the manifest?)")
        connection = serviceConnection
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            dropConnection()
            throw EmbedderException("embed service did not connect within $timeoutMs ms")
        }
        return messenger ?: run {
            dropConnection()
            throw EmbedderException("embed service connected without a binder")
        }
    }

    private fun dropConnection() {
        runCatching { connection?.let { context.unbindService(it) } }
        connection = null
        messenger = null
    }

    companion object {
        /** Generous enough for a cold GPU load; the engine load happens on the first call. */
        const val DEFAULT_TIMEOUT_MS = 180_000L
    }
}
