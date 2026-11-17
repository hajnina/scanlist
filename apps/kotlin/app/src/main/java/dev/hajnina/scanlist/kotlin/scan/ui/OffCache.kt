package dev.hajnina.scanlist.kotlin.scan.ui

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * OFF.md §4 — the barcode → product-text cache (card B5).
 *
 * One JSON document at `<filesDir>/off/cache.json`, written atomically (tmp + rename), the same plain
 * `java.io` approach card B2 chose for lists and B6 for settings: a few kilobytes do not justify
 * DataStore, the file is inspectable, and the whole TTL rule is JVM-testable with an injected clock.
 *
 * Only the three normative fields are stored per barcode — `text`, `hit`, `fetchedAt` — plus a local
 * `usedAt` for the LRU eviction OFF.md §4.6 recommends (it is not part of the OFF contract and is not
 * exported). The raw OFF payload is never kept.
 *
 * TTLs: a hit (even one with `text: null`) is fresh for 30 days, a miss for 1 day, and a clock that
 * moved backwards clamps the age to 0 (so a wrong wall clock cannot throw the cache away).
 */
class OffCache(
    private val file: File,
    private val clock: () -> Long = { System.currentTimeMillis() / 1_000L },
) {
    /** One cache entry; [hit] distinguishes "product exists" from "product not found". */
    data class Entry(
        val text: String?,
        val hit: Boolean,
        val fetchedAt: Long,
        val usedAt: Long = fetchedAt,
    ) {
        fun ttlSeconds(): Long = if (hit) HIT_TTL_SECONDS else MISS_TTL_SECONDS

        /** OFF.md §4: fresh iff `0 <= now - fetchedAt < TTL`; at exactly TTL it is expired. */
        fun fresh(nowSeconds: Long): Boolean = ageSeconds(nowSeconds) < ttlSeconds()

        fun ageSeconds(nowSeconds: Long): Long = (nowSeconds - fetchedAt).coerceAtLeast(0L)
    }

    private val entries = LinkedHashMap<String, Entry>()
    private var loaded = false

    /** Fresh-or-stale entry for [barcode], or null when it was never asked. */
    fun get(barcode: String, nowSeconds: Long = clock()): Entry? {
        load()
        val entry = entries[barcode] ?: return null
        // LRU bookkeeping is in-memory: persisting on every read would rewrite the file per frame.
        entries[barcode] = entry.copy(usedAt = nowSeconds)
        return entry
    }

    /** Overwrite [barcode] with the outcome just received (positive for a hit, negative for a miss). */
    fun put(barcode: String, text: String?, hit: Boolean, nowSeconds: Long = clock()): Entry {
        load()
        val entry = Entry(text = text, hit = hit, fetchedAt = nowSeconds, usedAt = nowSeconds)
        entries[barcode] = entry
        evict(nowSeconds)
        save()
        return entry
    }

    val size: Int get() = entries.size

    /** Drop a barcode (tests + a future "clear cache" button). */
    fun remove(barcode: String): Boolean {
        load()
        val removed = entries.remove(barcode) != null
        if (removed) save()
        return removed
    }

    fun clear() {
        load()
        entries.clear()
        save()
    }

    /** OFF.md §4.6: cap at [MAX_ENTRIES], expired first, then least recently used. */
    private fun evict(nowSeconds: Long) {
        if (entries.size <= MAX_ENTRIES) return
        val expired = entries.filterValues { !it.fresh(nowSeconds) }.keys.toList()
        for (key in expired) {
            if (entries.size <= MAX_ENTRIES) break
            entries.remove(key)
        }
        if (entries.size <= MAX_ENTRIES) return
        val byAge = entries.entries.sortedBy { it.value.usedAt }
        for (entry in byAge) {
            if (entries.size <= MAX_ENTRIES) break
            entries.remove(entry.key)
        }
    }

    // ---------------------------------------------------------------- persistence

    private fun load() {
        if (loaded) return
        loaded = true
        val text = if (file.isFile) runCatching { file.readText(Charsets.UTF_8) }.getOrNull() else null
        val root = text?.let { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() } ?: return
        val stored = root["entries"] as? JsonObject ?: return
        for ((barcode, element) in stored) {
            val obj = runCatching { element.jsonObject }.getOrNull() ?: continue
            val hit = runCatching { obj["hit"]!!.jsonPrimitive.boolean }.getOrNull() ?: continue
            val fetchedAt = runCatching { obj["fetchedAt"]!!.jsonPrimitive.long }.getOrNull() ?: continue
            val usedAt = runCatching { obj["usedAt"]!!.jsonPrimitive.long }.getOrDefault(fetchedAt)
            val name = (obj["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            entries[barcode] = Entry(name, hit, fetchedAt, usedAt)
        }
    }

    private fun save() {
        val document = buildJsonObject {
            put("version", VERSION)
            putJsonObject("entries") {
                for ((barcode, entry) in entries) {
                    putJsonObject(barcode) {
                        if (entry.text == null) put("text", JsonNull) else put("text", entry.text)
                        put("hit", entry.hit)
                        put("fetchedAt", entry.fetchedAt)
                        put("usedAt", entry.usedAt)
                    }
                }
            }
        }
        val text = Json { prettyPrint = false }.encodeToString(JsonObject.serializer(), document) + "\n"
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text, Charsets.UTF_8)
        if (!tmp.renameTo(file)) {
            // renameTo can fail across mounts; same fallback as ListStore/SettingsStore.
            file.writeText(text, Charsets.UTF_8)
            tmp.delete()
        }
    }

    companion object {
        /** OFF.md §4: positive hit TTL, 30 days. */
        const val HIT_TTL_SECONDS: Long = 2_592_000L

        /** OFF.md §4: negative (miss) TTL, 1 day. */
        const val MISS_TTL_SECONDS: Long = 86_400L

        /** OFF.md §4.6: SHOULD cap the cache at 1,000 entries. */
        const val MAX_ENTRIES: Int = 1_000

        const val VERSION: Int = 1

        /** Standard location: `<filesDir>/off/cache.json`. */
        fun forFilesDir(filesDir: File): OffCache = OffCache(File(File(filesDir, "off"), "cache.json"))
    }
}
