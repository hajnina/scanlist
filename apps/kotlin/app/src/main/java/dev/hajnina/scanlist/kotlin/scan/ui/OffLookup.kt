package dev.hajnina.scanlist.kotlin.scan.ui

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// OFF.md §2–§5, the barcode half of the magic scan (card B5). The split is deliberate:
//  * OffRequest / OffResponse / OffText — the normative strings and bytes, pure and replayed against
//    `shared/off/fixtures/` by the tests;
//  * HttpUrlConnectionTransport — the one thin networking class (no third-party HTTP dependency);
//  * OffResolver — cache → network → degrade, with the TTL, stale-while-revalidate and single-flight
//    rules of OFF.md §4;
//  * RequestThrottle / OffJournal — the etiquette (100 req/min, ≥100 ms apart) and dedupe.
// Everything except the transport is JVM-tested with a fake transport and a fake clock.

/** OFF.md §2: the one request this app is allowed to make. */
object OffRequest {
    const val USER_AGENT: String = "ScanList/0.1"

    const val FIELDS: String = "code,product_name,brands,generic_name,categories"

    private const val HOST = "https://world.openfoodfacts.org"

    /** OFF.md §2: EAN-8, UPC-A/EAN-13, ITF-14 — digits only, sent verbatim (no zero stripping). */
    private val BARCODE = Regex("^[0-9]{8,14}$")

    fun isValidBarcode(value: String): Boolean = BARCODE.matches(value)

    /** `…/api/v2/product/{barcode}.json?fields=…` exactly as OFF.md §2 spells it. */
    fun url(barcode: String): String = "$HOST/api/v2/product/$barcode.json?fields=$FIELDS"
}

/** OFF.md §2.1 outcome of one lookup attempt. */
enum class OffOutcome { HIT, MISS, TRANSIENT }

/** What the HTTP answer means, and the query text it yields (OFF.md §3, possibly null). */
data class OffClassification(
    val outcome: OffOutcome,
    val text: String?,
)

/**
 * OFF.md §2.1 outcome table: **HTTP status is authoritative**, `status_verbose` is never parsed, and a
 * 200 without a product object is a miss even when `status` claims otherwise. Anything unparseable is
 * transient — a funny page must not be cached as "no such product".
 */
object OffResponse {

    fun classify(httpStatus: Int, body: String?): OffClassification = when {
        httpStatus == 404 -> OffClassification(OffOutcome.MISS, null)
        httpStatus != 200 -> OffClassification(OffOutcome.TRANSIENT, null)
        else -> classifyOk(body)
    }

    private fun classifyOk(body: String?): OffClassification {
        val root = body?.let { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() }
            ?: return OffClassification(OffOutcome.TRANSIENT, null)
        val status = runCatching { root["status"]!!.jsonPrimitive.int }.getOrNull()
            ?: return OffClassification(OffOutcome.MISS, null)
        if (status != 1) return OffClassification(OffOutcome.MISS, null)
        val product = root["product"] as? JsonObject
            ?: return OffClassification(OffOutcome.MISS, null)
        // A hit without a usable name is still a hit (OFF.md §2.1): cached 30 days with text = null.
        return OffClassification(OffOutcome.HIT, OffText.derive(product))
    }
}

/** One HTTP answer, transport-agnostic. [status] 0 means "the request never produced a response". */
data class OffHttp(
    val status: Int,
    val body: String?,
    val retryAfterSeconds: Long? = null,
)

/** The networking seam; the JVM tests fake it, the app uses [HttpUrlConnectionTransport]. */
fun interface OffTransport {
    fun get(url: String, userAgent: String): OffHttp
}

/**
 * `HttpURLConnection` transport: 3 s connect / 10 s read budget (OFF.md §2), redirects followed (the
 * JDK default allows up to 20 for HTTP; only HTTPS is ever built here), the fixed User-Agent, and a
 * `Retry-After` read for 429. Any exception degrades to status 0, which [OffResponse] calls transient.
 */
class HttpUrlConnectionTransport(
    private val connectTimeoutMs: Int = 3_000,
    private val readTimeoutMs: Int = 10_000,
) : OffTransport {

    override fun get(url: String, userAgent: String): OffHttp = runCatching {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.requestMethod = "GET"
            connection.setRequestProperty("User-Agent", userAgent)
            connection.setRequestProperty("Accept", "application/json")
            connection.instanceFollowRedirects = true
            val status = connection.responseCode
            val stream: InputStream? = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.let { input -> input.bufferedReader(Charsets.UTF_8).use { it.readText() } }
            OffHttp(status, body, retryAfterSeconds(connection.getHeaderField("Retry-After")))
        } finally {
            connection.disconnect()
        }
    }.getOrDefault(OffHttp(0, null))

    /** Seconds from `Retry-After` (the delta form; the HTTP-date form is treated as the 60 s default). */
    private fun retryAfterSeconds(header: String?): Long? =
        header?.trim()?.toLongOrNull()?.coerceAtLeast(0L)
}

/** Where the text came from, for the chip's honest label ("OFF" / "cached" / "offline"). */
enum class OffSource { CACHE, NETWORK, NONE }

/** The result the scan screen consumes; `text == null` simply means "no barcode text this tick". */
data class OffLookupResult(
    val text: String?,
    val source: OffSource,
    val stale: Boolean,
    /** True when OFF answered "this product exists" (even with no usable name). */
    val hit: Boolean,
    val outcome: OffOutcome?,
    val retryAfterSeconds: Long? = null,
    val note: String? = null,
) {
    companion object {
        val NONE: OffLookupResult = OffLookupResult(null, OffSource.NONE, false, false, null)
    }
}

/**
 * OFF.md §4 resolution: fresh cache → answer without a request; expired/absent → one request; a
 * transient failure → keep using the stale text (stale-while-revalidate) but **never** extend
 * `fetchedAt`; an invalid barcode makes no request and writes no cache entry.
 */
class OffResolver(
    private val cache: OffCache,
    private val transport: OffTransport,
    private val throttle: RequestThrottle = RequestThrottle(),
    /** Wall clock in **milliseconds**; the cache works in seconds (OFF.md §4 `fetchedAt`). */
    private val clock: () -> Long = { System.currentTimeMillis() },
) {

    fun lookup(barcode: String, nowMs: Long = clock()): OffLookupResult {
        if (!OffRequest.isValidBarcode(barcode)) {
            return OffLookupResult.NONE.copy(note = "not a barcode")
        }
        val nowSeconds = nowMs / 1_000L
        val cached = cache.get(barcode, nowSeconds)
        if (cached != null && cached.fresh(nowSeconds)) {
            return OffLookupResult(
                text = cached.text,
                source = OffSource.CACHE,
                stale = false,
                hit = cached.hit,
                outcome = null,
            )
        }

        if (!throttle.tryAcquire(nowMs)) {
            return degraded(cached, note = "OFF rate limit reached — using the cache")
        }

        val http = transport.get(OffRequest.url(barcode), OffRequest.USER_AGENT)
        val classification = OffResponse.classify(http.status, http.body)
        return when (classification.outcome) {
            OffOutcome.HIT, OffOutcome.MISS -> {
                val hit = classification.outcome == OffOutcome.HIT
                cache.put(barcode, classification.text, hit, nowSeconds)
                OffLookupResult(
                    text = classification.text,
                    source = OffSource.NETWORK,
                    stale = false,
                    hit = hit,
                    outcome = classification.outcome,
                    retryAfterSeconds = http.retryAfterSeconds,
                )
            }
            OffOutcome.TRANSIENT -> degraded(
                cached,
                note = "OFF unavailable — offline ranking keeps working",
                retryAfterSeconds = http.retryAfterSeconds,
            )
        }
    }

    /** Transient failure: the stale text still ranks this tick, and nothing is written (OFF.md §4.3). */
    private fun degraded(
        cached: OffCache.Entry?,
        note: String,
        retryAfterSeconds: Long? = null,
    ): OffLookupResult = OffLookupResult(
        text = cached?.text,
        source = if (cached != null) OffSource.CACHE else OffSource.NONE,
        stale = cached != null,
        hit = cached?.hit ?: false,
        outcome = OffOutcome.TRANSIENT,
        retryAfterSeconds = retryAfterSeconds,
        note = note,
    )
}

/**
 * OFF.md §5 etiquette: never more than 100 product requests per minute and at least 100 ms apart.
 * A rejected request is not queued — the scan tick simply goes without a barcode text (the cache and
 * the camera sources carry it), which is the honest, non-blocking behaviour.
 */
class RequestThrottle(
    private val minSpacingMs: Long = 100L,
    private val maxPerMinute: Int = 100,
) {
    private val recent = ArrayDeque<Long>()

    @Synchronized
    fun tryAcquire(nowMs: Long): Boolean {
        while (recent.isNotEmpty() && nowMs - recent.first() >= 60_000L) recent.removeFirst()
        if (recent.size >= maxPerMinute) return false
        val last = recent.lastOrNull()
        if (last != null && nowMs - last < minSpacingMs) return false
        recent.addLast(nowMs)
        return true
    }
}

/**
 * OFF.md §4.5 single-flight: at most one in-flight request per barcode; concurrent ticks share the
 * result. The controller starts a lookup only when [begin] returns true.
 */
class OffJournal {
    private val inFlight = HashSet<String>()

    @Synchronized
    fun begin(barcode: String): Boolean = if (barcode in inFlight) false else inFlight.add(barcode)

    @Synchronized
    fun end(barcode: String) {
        inFlight.remove(barcode)
    }

    @Synchronized
    fun isInFlight(barcode: String): Boolean = barcode in inFlight
}
