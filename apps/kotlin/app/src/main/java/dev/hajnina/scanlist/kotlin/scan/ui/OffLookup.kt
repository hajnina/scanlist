package dev.hajnina.scanlist.kotlin.scan.ui

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
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
 * OFF.md §2 redirect policy: follow at most [MAX_HOPS] redirects and never leave HTTPS.
 *
 * The JDK default (20 hops, every scheme) is both too permissive and an SSRF-shaped footgun; OFF's
 * own documentation only ever promises HTTPS. A rejected target makes the transport degrade to its
 * status-0 "transient" answer, so the camera and the ranking loop are unaffected.
 */
object OffRedirect {
    const val MAX_HOPS: Int = 3

    /**
     * Resolve [location] against [current], or return `null` when the hop budget is exhausted (the
     * caller then surfaces the 3xx itself as a transient failure). Throws for a non-HTTPS target.
     */
    fun resolve(current: String, location: String?, followed: Int): String? {
        val target = location?.trim()
        if (target.isNullOrEmpty() || followed >= MAX_HOPS) return null
        val resolved = URL(URL(current), target).toString()
        require(URI(resolved).scheme.equals("https", ignoreCase = true)) {
            "OFF redirects must stay on HTTPS (got $resolved)"
        }
        return resolved
    }
}

/** One HTTP hop before [OffRedirect] has a say: status, body, Retry-After and Location. */
private data class OffHop(
    val status: Int,
    val body: String?,
    val retryAfterSeconds: Long?,
    val location: String?,
)

/**
 * `HttpURLConnection` transport: 3 s connect / 10 s read budget (OFF.md §2), [OffRedirect]'s
 * ≤3-hop HTTPS-only policy, the fixed User-Agent, and a `Retry-After` read for 429. Any exception
 * degrades to status 0, which [OffResponse] calls transient.
 */
class HttpUrlConnectionTransport(
    private val connectTimeoutMs: Int = 3_000,
    private val readTimeoutMs: Int = 10_000,
) : OffTransport {

    override fun get(url: String, userAgent: String): OffHttp =
        runCatching { fetch(url, userAgent) }.getOrDefault(OffHttp(0, null))

    private fun fetch(url: String, userAgent: String): OffHttp {
        var current = url
        var followed = 0
        while (true) {
            val hop = requestOnce(current, userAgent)
            if (hop.status !in 300..399) {
                return OffHttp(hop.status, hop.body, hop.retryAfterSeconds)
            }
            current = OffRedirect.resolve(current, hop.location, followed)
                ?: return OffHttp(hop.status, null)
            followed += 1
        }
    }

    private fun requestOnce(url: String, userAgent: String): OffHop {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.requestMethod = "GET"
            connection.setRequestProperty("User-Agent", userAgent)
            connection.setRequestProperty("Accept", "application/json")
            // Redirects are followed by hand so OffRedirect enforces the hop/scheme policy.
            connection.instanceFollowRedirects = false
            val status = connection.responseCode
            val stream: InputStream? = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.let { input -> input.bufferedReader(Charsets.UTF_8).use { it.readText() } }
            OffHop(
                status = status,
                body = body,
                retryAfterSeconds = retryAfterSeconds(connection.getHeaderField("Retry-After")),
                location = connection.getHeaderField("Location"),
            )
        } finally {
            connection.disconnect()
        }
    }

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

/** OFF.md §4.4/§5 retry policy: Retry-After wins; otherwise 1 s, 2 s, 4 s … capped at 60 s. */
private const val HTTP_TOO_MANY_REQUESTS = 429
private const val RETRY_AFTER_DEFAULT_MS = 60_000L
private const val BACKOFF_BASE_MS = 1_000L
private const val BACKOFF_CAP_MS = 60_000L
private const val MAX_TRANSIENT_ATTEMPTS = 3

/**
 * OFF.md §4 resolution: fresh cache → answer without a request; expired/absent → one request; a
 * transient failure → keep using the stale text (stale-while-revalidate) but **never** extend
 * `fetchedAt`; an invalid barcode makes no request and writes no cache entry.
 *
 * OFF.md §4.4/§5 backoff lives here, per barcode: a 429 waits `Retry-After` (60 s when absent), a
 * 5xx/timeout backs off 1 s → 2 s → 4 s (cap 60 s), and at most three attempts are made. While a
 * barcode is backing off, the lookup answers from the cache instead of re-requesting on every tick.
 */
class OffResolver(
    private val cache: OffCache,
    private val transport: OffTransport,
    private val throttle: RequestThrottle = RequestThrottle(),
    /** Wall clock in **milliseconds**; the cache works in seconds (OFF.md §4 `fetchedAt`). */
    private val clock: () -> Long = { System.currentTimeMillis() },
) {

    /** Per-barcode retry schedule: transient failures seen and the earliest next request. */
    private data class Retry(val failures: Int, val nextAttemptAtMs: Long)

    private val retries = HashMap<String, Retry>()
    private val retryLock = Any()

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

        // OFF.md §4.4/§5: a barcode that just failed waits out its Retry-After/backoff window; the
        // scan tick keeps ranking from the cache instead of hammering a struggling service.
        retryGate(barcode, nowMs)?.let { note -> return degraded(cached, note = note) }

        if (!throttle.tryAcquire(nowMs)) {
            return degraded(cached, note = "OFF rate limit reached — using the cache")
        }

        val http = transport.get(OffRequest.url(barcode), OffRequest.USER_AGENT)
        val classification = OffResponse.classify(http.status, http.body)
        return when (classification.outcome) {
            OffOutcome.HIT, OffOutcome.MISS -> {
                noteSuccess(barcode)
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
            OffOutcome.TRANSIENT -> {
                noteTransient(barcode, nowMs, http)
                degraded(
                    cached,
                    note = "OFF unavailable — offline ranking keeps working",
                    retryAfterSeconds = http.retryAfterSeconds,
                )
            }
        }
    }

    /** Null while a request may go ahead; otherwise the honest reason the tick uses the cache. */
    private fun retryGate(barcode: String, nowMs: Long): String? = synchronized(retryLock) {
        val state = retries[barcode] ?: return null
        when {
            state.failures >= MAX_TRANSIENT_ATTEMPTS ->
                "OFF retry budget exhausted — using the cache"
            nowMs < state.nextAttemptAtMs ->
                "OFF backing off — using the cache"
            else -> null
        }
    }

    private fun noteTransient(barcode: String, nowMs: Long, http: OffHttp) {
        synchronized(retryLock) {
            val failures = (retries[barcode]?.failures ?: 0) + 1
            retries[barcode] = Retry(failures, nowMs + retryDelayMs(http, failures))
        }
    }

    private fun noteSuccess(barcode: String) {
        synchronized(retryLock) { retries.remove(barcode) }
    }

    /**
     * OFF.md §4.4/§5: `Retry-After` when OFF sent one (429), 60 s for a 429 without it, otherwise
     * exponential 1 s, 2 s, 4 s … capped at 60 s. The third failure's 4 s value is recorded but the
     * attempt budget stops the fourth request.
     */
    private fun retryDelayMs(http: OffHttp, failures: Int): Long {
        http.retryAfterSeconds?.let { return it * 1_000L }
        if (http.status == HTTP_TOO_MANY_REQUESTS) return RETRY_AFTER_DEFAULT_MS
        val shift = (failures - 1).coerceIn(0, 16)
        return (BACKOFF_BASE_MS shl shift).coerceAtMost(BACKOFF_CAP_MS)
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
