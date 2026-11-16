package dev.hajnina.llmserve

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** What the UI process knows about the server. The UI never touches Store/Runner/Live/DiskCache (they live in the :server process); it reads this snapshot. */
data class Snap(
    val ts: Long = 0, val serverPid: Int = 0, val enabled: Boolean = true, val state: String = "server process down",
    val addr: String? = null, val startedAt: Long = 0, val restarts: Int = 0,
    val phase: String = "idle", val pct: Float = 0f, val promptTokens: Int = 0, val promptTps: Float = 0f, val decoded: Int = 0, val tps: Float = 0f,
    val totIn: Long = 0, val totCached: Long = 0, val totOut: Long = 0, val totReqs: Long = 0,
    val key: String = "", val model: String = "", val models: List<String> = emptyList(), val ctx: Int = 65536, val alias: String = "",
    val disk: String = "", val diskBytes: Long = 0, val diskCount: Int = 0,
    val tail: List<String> = emptyList(), val events: List<String> = emptyList(),
) {
    /** The :server process refreshes the snapshot at least every 5 s; older than 15 s means that process is dead or frozen. */
    val fresh: Boolean get() = ts > 0 && System.currentTimeMillis() - ts < 15_000
}

object Status {
    private fun file(c: Context) = File(c.filesDir, "status.json")

    /** :server process only. Atomic (tmp + rename) so the UI never reads half a file. */
    fun write(c: Context) {
        val o = JSONObject()
            .put("ts", System.currentTimeMillis()).put("pid", android.os.Process.myPid()).put("enabled", Store.enabled)
            .put("state", Runner.state).put("addr", Runner.addr ?: JSONObject.NULL).put("startedAt", Runner.startedAt).put("restarts", Runner.restarts)
            .put("phase", Live.phase).put("pct", Live.pct.toDouble()).put("promptTokens", Live.promptTokens).put("promptTps", Live.promptTps.toDouble())
            .put("decoded", Live.decoded).put("tps", Live.tps.toDouble())
            .put("totIn", Store.totIn).put("totCached", Store.totCached).put("totOut", Store.totOut).put("totReqs", Store.totReqs)
            .put("key", Store.key).put("model", Store.model).put("models", JSONArray(Store.models())).put("ctx", Store.ctx).put("alias", Store.alias)
            .put("disk", DiskCache.status).put("diskBytes", DiskCache.total()).put("diskCount", DiskCache.count())
            .put("tail", JSONArray(Runner.tail.toList().takeLast(6).map { it.take(110) })).put("events", JSONArray(Events.last(6)))
        val f = file(c); val t = File(c.filesDir, "status.json.tmp")
        t.writeText(o.toString()); t.renameTo(f)
    }

    /** UI process: null if there is no snapshot at all yet. */
    fun read(c: Context): Snap? = try {
        val o = JSONObject(file(c).readText())
        fun strs(k: String) = o.optJSONArray(k)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        Snap(o.getLong("ts"), o.optInt("pid"), o.optBoolean("enabled", true), o.optString("state"), if (o.isNull("addr")) null else o.optString("addr"),
            o.optLong("startedAt"), o.optInt("restarts"), o.optString("phase", "idle"), o.optDouble("pct").toFloat(), o.optInt("promptTokens"), o.optDouble("promptTps").toFloat(),
            o.optInt("decoded"), o.optDouble("tps").toFloat(), o.optLong("totIn"), o.optLong("totCached"), o.optLong("totOut"), o.optLong("totReqs"),
            o.optString("key"), o.optString("model"), strs("models"), o.optInt("ctx", 65536), o.optString("alias"),
            o.optString("disk"), o.optLong("diskBytes"), o.optInt("diskCount"), strs("tail"), strs("events"))
    } catch (e: Exception) { null }
}

/** Persistent event log (restarts, exit reasons), :server process only. Survives process death, so the next start can still show why the last one died. */
object Events {
    private lateinit var f: File
    private val recent = java.util.concurrent.ConcurrentLinkedDeque<String>()
    @Synchronized fun init(c: Context) {
        if (::f.isInitialized) return
        f = File(c.filesDir, "events.log")
        runCatching { f.readLines().takeLast(20).forEach { recent.add(it) } }
    }
    @Synchronized fun add(msg: String) {
        val line = java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date()) + " " + msg
        recent.add(line); while (recent.size > 50) recent.poll()
        if (::f.isInitialized) runCatching {
            f.appendText(line + "\n")
            if (f.length() > 64_000) f.writeText(f.readLines().takeLast(200).joinToString("\n") + "\n")
        }
    }
    fun last(n: Int): List<String> = recent.toList().takeLast(n)
}
