package dev.hajnina.scanlist.kotlin.scan.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * OFF.md §2/§4/§5: the normative request string, the status-authoritative outcome table, and the
 * resolver's cache-first / stale-while-revalidate / degrade-to-cache rules. The transport is faked;
 * the one class that really opens a socket ([HttpUrlConnectionTransport]) is deliberately thin and is
 * verified by the app build, not here.
 */
class OffLookupTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val nutellaBody =
        """{"code":"3017620422003","status":1,"status_verbose":"product found","product":{"product_name":"Nutella","brands":"Ferrero, Nutella"}}"""

    private class FakeTransport(private vararg val answers: OffHttp) : OffTransport {
        val urls = mutableListOf<String>()
        val userAgents = mutableListOf<String>()

        override fun get(url: String, userAgent: String): OffHttp {
            urls += url
            userAgents += userAgent
            return answers.getOrElse(urls.size - 1) { answers.last() }
        }
    }

    private fun cache(file: File = File(temp.newFolder("off"), "cache.json")) = OffCache(file)

    // ---------------------------------------------------------------- request + response contract

    @Test
    fun `the request is the one OFF section 2 spells`() {
        assertEquals(
            "https://world.openfoodfacts.org/api/v2/product/3017620422003.json" +
                "?fields=code,product_name,brands,generic_name,categories",
            OffRequest.url("3017620422003"),
        )
        assertEquals("ScanList/0.1", OffRequest.USER_AGENT)
        for (barcode in listOf("30176204", "3017620422003", "12345678901234")) {
            assertTrue("$barcode is a valid EAN/UPC/ITF code", OffRequest.isValidBarcode(barcode))
        }
        for (barcode in listOf("", "1234567", "123456789012345", "30176204a", " 30176204", "3017-6204")) {
            assertFalse("'$barcode' is not a barcode", OffRequest.isValidBarcode(barcode))
        }
    }

    @Test
    fun `HTTP status is authoritative and status_verbose is never parsed`() {
        assertEquals(OffOutcome.MISS, OffResponse.classify(404, """{"status":1,"product":{"product_name":"Ghost"}}""").outcome)
        assertEquals(OffOutcome.TRANSIENT, OffResponse.classify(500, null).outcome)
        assertEquals(OffOutcome.TRANSIENT, OffResponse.classify(429, "").outcome)
        assertEquals(
            "status 0 with a product object is still a miss",
            OffOutcome.MISS,
            OffResponse.classify(200, """{"status":0,"product":{"product_name":"Ghost"}}""").outcome,
        )
        assertEquals(
            "status 1 without a product object is a miss, not a hit",
            OffOutcome.MISS,
            OffResponse.classify(200, """{"status":1}""").outcome,
        )
    }

    @Test
    fun `an unparseable 200 is transient - never cached as "no such product"`() {
        assertEquals(OffOutcome.TRANSIENT, OffResponse.classify(200, null).outcome)
        assertEquals(OffOutcome.TRANSIENT, OffResponse.classify(200, "").outcome)
        assertEquals(OffOutcome.TRANSIENT, OffResponse.classify(200, "<html>oops</html>").outcome)
    }

    @Test
    fun `a 200 hit carries the OFF section 3 text, and a nameless hit is still a hit`() {
        val hit = OffResponse.classify(200, nutellaBody)
        assertEquals(OffOutcome.HIT, hit.outcome)
        assertEquals("Nutella", hit.text)

        val nameless = OffResponse.classify(200, """{"status":1,"product":{"code":"11111111"}}""")
        assertEquals(OffOutcome.HIT, nameless.outcome)
        assertNull(nameless.text)
    }

    // ---------------------------------------------------------------- resolver

    @Test
    fun `a fresh cache entry answers without any request`() {
        val store = cache()
        store.put("3017620422003", "Nutella", hit = true, nowSeconds = 100)
        val transport = FakeTransport(OffHttp(200, nutellaBody))
        val resolver = OffResolver(store, transport)

        val result = resolver.lookup("3017620422003", nowMs = 200_000)
        assertEquals("Nutella", result.text)
        assertEquals(OffSource.CACHE, result.source)
        assertFalse(result.stale)
        assertTrue(result.hit)
        assertTrue("no network call for a fresh entry", transport.urls.isEmpty())
    }

    @Test
    fun `an expired entry is refetched and the new answer replaces it`() {
        val store = cache()
        store.put("3017620422003", "Old name", hit = true, nowSeconds = 0)
        val transport = FakeTransport(OffHttp(200, nutellaBody))
        val resolver = OffResolver(store, transport)

        val result = resolver.lookup("3017620422003", nowMs = OffCache.HIT_TTL_SECONDS * 1_000)
        assertEquals("Nutella", result.text)
        assertEquals(OffSource.NETWORK, result.source)
        assertFalse(result.stale)
        assertEquals(OffRequest.url("3017620422003"), transport.urls.single())
        assertEquals(OffRequest.USER_AGENT, transport.userAgents.single())
        assertEquals("Nutella", store.get("3017620422003", OffCache.HIT_TTL_SECONDS)!!.text)
    }

    @Test
    fun `a transient failure keeps the stale text and never extends its fetchedAt`() {
        val store = cache()
        store.put("3017620422003", "Nutella", hit = true, nowSeconds = 0)
        val transport = FakeTransport(OffHttp(503, "down"))
        val resolver = OffResolver(store, transport)

        val result = resolver.lookup("3017620422003", nowMs = OffCache.HIT_TTL_SECONDS * 1_000)
        assertEquals("Nutella", result.text)
        assertEquals(OffSource.CACHE, result.source)
        assertTrue(result.stale)
        assertTrue(result.hit)
        assertEquals(OffOutcome.TRANSIENT, result.outcome)
        assertEquals("the stale entry was not re-dated", 0L, store.get("3017620422003", 0)!!.fetchedAt)
    }

    @Test
    fun `a transient failure with no cache degrades to "no barcode text"`() {
        val store = cache()
        val transport = FakeTransport(OffHttp(0, null))
        val resolver = OffResolver(store, transport)

        val result = resolver.lookup("3017620422003", nowMs = 1_000)
        assertNull(result.text)
        assertEquals(OffSource.NONE, result.source)
        assertFalse(result.stale)
        assertEquals(OffOutcome.TRANSIENT, result.outcome)
        assertNull("nothing is cached for a transient failure", store.get("3017620422003", 1))
    }

    @Test
    fun `a 404 is cached as a negative and served from cache afterwards`() {
        val store = cache()
        val transport = FakeTransport(OffHttp(404, """{"status":0,"status_verbose":"product not found"}"""))
        val resolver = OffResolver(store, transport)

        val first = resolver.lookup("3245390098214", nowMs = 0)
        assertEquals(OffOutcome.MISS, first.outcome)
        assertNull(first.text)
        assertFalse(first.hit)
        assertEquals(OffSource.NETWORK, first.source)

        val second = resolver.lookup("3245390098214", nowMs = 1_000)
        assertEquals(OffSource.CACHE, second.source)
        assertNull(second.text)
        assertFalse(second.hit)
        assertEquals("the negative answer was cached", 1, transport.urls.size)
        assertEquals(1, store.size)
    }

    @Test
    fun `an invalid barcode makes no request and writes no cache entry`() {
        val store = cache()
        val transport = FakeTransport(OffHttp(200, nutellaBody))
        val resolver = OffResolver(store, transport)

        val result = resolver.lookup("not-a-barcode", nowMs = 0)
        assertNull(result.text)
        assertEquals(OffSource.NONE, result.source)
        assertNull(result.outcome)
        assertEquals("not a barcode", result.note)
        assertTrue(transport.urls.isEmpty())
        assertEquals(0, store.size)
    }

    @Test
    fun `a 429 keeps Retry-After for the UI and falls back to the cache`() {
        val store = cache()
        store.put("3017620422003", "Nutella", hit = true, nowSeconds = 0)
        val transport = FakeTransport(OffHttp(429, "", retryAfterSeconds = 30))
        val resolver = OffResolver(store, transport)

        val result = resolver.lookup("3017620422003", nowMs = OffCache.HIT_TTL_SECONDS * 1_000)
        assertEquals(30L, result.retryAfterSeconds)
        assertEquals("Nutella", result.text)
        assertTrue(result.stale)
    }

    @Test
    fun `a throttled request is not queued - the tick simply goes without OFF`() {
        val store = cache()
        val transport = FakeTransport(OffHttp(200, nutellaBody))
        // Two different barcodes inside the 100 ms spacing window.
        val resolver = OffResolver(store, transport, RequestThrottle(minSpacingMs = 100))

        val first = resolver.lookup("3017620422003", nowMs = 0)
        assertEquals(OffSource.NETWORK, first.source)
        val second = resolver.lookup("3017620425035", nowMs = 50)
        assertEquals(OffSource.NONE, second.source)
        assertNull(second.text)
        assertTrue(second.note!!.contains("rate limit"))
        assertEquals("the second request was not sent", 1, transport.urls.size)
        assertEquals("and not cached either", 1, store.size)
    }

    // ---------------------------------------------------------------- OFF.md §4.4/§5 backoff

    @Test
    fun `a 429 is not retried before its Retry-After elapses`() {
        val store = cache()
        val transport = FakeTransport(
            OffHttp(429, "", retryAfterSeconds = 30),
            OffHttp(200, nutellaBody),
        )
        val resolver = OffResolver(store, transport, RequestThrottle(minSpacingMs = 0))

        assertEquals(OffOutcome.TRANSIENT, resolver.lookup("3017620422003", nowMs = 0).outcome)
        val early = resolver.lookup("3017620422003", nowMs = 29_999)
        assertEquals(OffOutcome.TRANSIENT, early.outcome)
        assertTrue("the tick says it is backing off", early.note!!.contains("backing off"))
        assertEquals("no request inside Retry-After", 1, transport.urls.size)

        val retried = resolver.lookup("3017620422003", nowMs = 30_000)
        assertEquals(OffOutcome.HIT, retried.outcome)
        assertEquals("Nutella", retried.text)
        assertEquals(2, transport.urls.size)
    }

    @Test
    fun `a 429 without Retry-After waits the 60 s default`() {
        val store = cache()
        val transport = FakeTransport(OffHttp(429, ""), OffHttp(200, nutellaBody))
        val resolver = OffResolver(store, transport, RequestThrottle(minSpacingMs = 0))

        resolver.lookup("3017620422003", nowMs = 0)
        resolver.lookup("3017620422003", nowMs = 59_999)
        assertEquals(1, transport.urls.size)
        assertEquals(OffOutcome.HIT, resolver.lookup("3017620422003", nowMs = 60_000).outcome)
        assertEquals(2, transport.urls.size)
    }

    @Test
    fun `a 500 backs off 1 s then 2 s and stops after the third attempt`() {
        val store = cache()
        val transport = FakeTransport(OffHttp(500, "down")) // every answer is a 5xx
        val resolver = OffResolver(store, transport, RequestThrottle(minSpacingMs = 0))

        assertEquals(OffOutcome.TRANSIENT, resolver.lookup("3017620422003", nowMs = 0).outcome)
        assertEquals(1, transport.urls.size)

        resolver.lookup("3017620422003", nowMs = 999)
        assertEquals("the first retry waits 1 s", 1, transport.urls.size)
        assertEquals(OffOutcome.TRANSIENT, resolver.lookup("3017620422003", nowMs = 1_000).outcome)
        assertEquals(2, transport.urls.size)

        resolver.lookup("3017620422003", nowMs = 2_999)
        assertEquals("the second retry waits 2 s", 2, transport.urls.size)
        assertEquals(OffOutcome.TRANSIENT, resolver.lookup("3017620422003", nowMs = 3_000).outcome)
        assertEquals(3, transport.urls.size)

        // The third failure schedules 4 s, but the three-attempt budget refuses a fourth request.
        val exhausted = resolver.lookup("3017620422003", nowMs = 7_000)
        assertTrue("the tick says why it stopped", exhausted.note!!.contains("retry budget"))
        resolver.lookup("3017620422003", nowMs = 120_000)
        assertEquals("no fourth attempt", 3, transport.urls.size)
    }

    // ---------------------------------------------------------------- OFF.md §2 redirects

    @Test
    fun `redirects are capped at three hops`() {
        var url = OffRequest.url("3017620422003")
        var followed = 0
        while (followed < OffRedirect.MAX_HOPS) {
            val next = OffRedirect.resolve(url, "https://world.openfoodfacts.org/hop${followed + 1}", followed)
            assertNotNull("hop ${followed + 1} is allowed", next)
            url = next!!
            followed += 1
        }
        assertNull(
            "a fourth redirect is refused",
            OffRedirect.resolve(url, "https://world.openfoodfacts.org/hop4", followed),
        )
    }

    @Test
    fun `a redirect target must stay on HTTPS`() {
        val thrown = assertThrows(IllegalArgumentException::class.java) {
            OffRedirect.resolve("https://world.openfoodfacts.org/x", "http://world.openfoodfacts.org/y", 0)
        }
        assertTrue(thrown.message!!.contains("HTTPS"))

        assertEquals(
            "a relative redirect resolves against the HTTPS request",
            "https://world.openfoodfacts.org/next",
            OffRedirect.resolve("https://world.openfoodfacts.org/x", "/next", 0),
        )
        assertNull("a 3xx without Location is not followed", OffRedirect.resolve("https://world.openfoodfacts.org/x", null, 0))
    }

    // ---------------------------------------------------------------- etiquette + single-flight

    @Test
    fun `the throttle enforces 100 ms spacing`() {
        val throttle = RequestThrottle(minSpacingMs = 100, maxPerMinute = 100)
        assertTrue(throttle.tryAcquire(0))
        assertFalse(throttle.tryAcquire(50))
        assertFalse(throttle.tryAcquire(99))
        assertTrue(throttle.tryAcquire(100))
    }

    @Test
    fun `the throttle enforces 100 per minute without blocking forever`() {
        val throttle = RequestThrottle(minSpacingMs = 0, maxPerMinute = 2)
        assertTrue(throttle.tryAcquire(0))
        assertTrue(throttle.tryAcquire(1))
        assertFalse("third in the window is rejected", throttle.tryAcquire(2))
        // At 60 s the oldest request leaves the sliding window, so the next one is allowed again.
        assertTrue(throttle.tryAcquire(60_000))
        assertTrue("the second old request has aged out too", throttle.tryAcquire(60_001))
        assertFalse("two requests in the new window", throttle.tryAcquire(60_002))
    }

    @Test
    fun `the journal allows one in-flight request per barcode`() {
        val journal = OffJournal()
        assertTrue(journal.begin("3017620422003"))
        assertFalse("a second tick shares the in-flight lookup", journal.begin("3017620422003"))
        assertTrue(journal.begin("3017620425035"))
        assertTrue(journal.isInFlight("3017620422003"))
        journal.end("3017620422003")
        assertFalse(journal.isInFlight("3017620422003"))
        assertTrue("after the answer a retry may start", journal.begin("3017620422003"))
    }

    @Test
    fun `the resolver is single-flight agnostic - the journal is the caller's guard`() {
        // Documented split: the resolver always answers; ScanController's journal prevents duplicate
        // requests. This pins that the two classes compose without hidden state.
        val store = cache()
        val transport = FakeTransport(OffHttp(200, nutellaBody), OffHttp(200, nutellaBody))
        val resolver = OffResolver(store, transport, RequestThrottle(minSpacingMs = 0))
        val journal = OffJournal()

        assertTrue(journal.begin("3017620422003"))
        assertNotNull(resolver.lookup("3017620422003", nowMs = 0).text)
        journal.end("3017620422003")
        assertTrue(journal.begin("3017620422003"))
        assertNotNull(resolver.lookup("3017620422003", nowMs = OffCache.HIT_TTL_SECONDS * 1_000).text)
        journal.end("3017620422003")
        assertEquals(2, transport.urls.size)
    }
}
