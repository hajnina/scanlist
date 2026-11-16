package dev.hajnina.llmserve

import java.net.HttpURLConnection
import java.net.URL

/** What the server is doing right now + lifetime totals. Prefill progress and final counts come from the llama-server log (exact); tokens-so-far while generating from polling /slots (which cannot answer during a prefill batch). */
object Live {
    @Volatile var phase = "idle"          // idle | prompt | generating
    @Volatile var pct = 0f                // prompt progress 0..1
    @Volatile var promptTokens = 0        // prompt tokens processed so far
    @Volatile var promptTps = 0f
    @Volatile var decoded = 0             // tokens generated so far in this request
    @Volatile var tps = 0f                // live generation speed
    @Volatile var task = -1
    @Volatile var lastDoneAt = 0L
    private var procN = 0; private var outM = 0
    private var lastDec = 0; private var lastT = 0L

    private val reLaunch = Regex("""task (\d+) \| processing task""")
    private val rePrompt = Regex("""prompt processing, n_tokens =\s*(\d+), progress = ([0-9.]+), t =\s*[0-9.]+ s / ([0-9.]+) tokens per second""")
    private val rePromptEval = Regex("""prompt eval time =\s*[0-9.]+ ms /\s*(\d+) tokens""")
    private val reEval = Regex("""\|\s+eval time =\s*[0-9.]+ ms /\s*(\d+) tokens""")
    private val reRelease = Regex("""stop processing: n_tokens = (\d+)""")

    fun onLog(l: String) {
        reLaunch.find(l)?.let { task = it.groupValues[1].toInt(); phase = "prompt"; pct = 0f; promptTokens = 0; decoded = 0; tps = 0f; promptTps = 0f; procN = 0; outM = 0; lastDec = 0; lastT = 0; return }
        rePrompt.find(l)?.let { promptTokens = it.groupValues[1].toInt(); pct = it.groupValues[2].toFloat(); promptTps = it.groupValues[3].toFloat(); return }
        rePromptEval.find(l)?.let { procN = it.groupValues[1].toInt(); return }
        reEval.find(l)?.let { outM = it.groupValues[1].toInt(); return }
        reRelease.find(l)?.let {
            val z = it.groupValues[1].toInt(); val total = (z - outM).coerceAtLeast(procN)   // whole prompt incl. cached part
            Store.addRequest(total.toLong(), (total - procN).coerceAtLeast(0).toLong(), outM.toLong())
            phase = "idle"; pct = 0f; decoded = 0; tps = 0f; lastDoneAt = System.currentTimeMillis(); return
        }
    }

    /** Called ~1/s: tokens generated so far (only answers between batches, so during a prefill it times out and is ignored). */
    fun poll(addr: String) {
        try {
            val c = URL("http://$addr:${Store.PORT}/slots").openConnection() as HttpURLConnection
            c.connectTimeout = 600; c.readTimeout = 600; c.setRequestProperty("Authorization", "Bearer ${Store.key}")
            val s = c.inputStream.bufferedReader().readText()
            val busy = s.contains("\"is_processing\":true")
            val n = Regex("\"n_decoded\":(\\d+)").find(s)?.groupValues?.get(1)?.toInt() ?: 0
            if (busy && n > 0) {
                val now = System.currentTimeMillis()
                if (lastT != 0L && n >= lastDec && now > lastT) { val inst = (n - lastDec) * 1000f / (now - lastT); tps = if (tps == 0f) inst else tps * 0.5f + inst * 0.5f }
                lastDec = n; lastT = now; decoded = n; phase = "generating"; pct = 1f
            }
        } catch (_: Exception) { }
    }
}
