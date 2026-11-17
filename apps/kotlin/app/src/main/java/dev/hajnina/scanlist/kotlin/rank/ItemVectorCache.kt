package dev.hajnina.scanlist.kotlin.rank

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * The on-disk item-vector cache of RANK.md §2.1 (card B3): one small binary file per docText, in an
 * app-private directory, readable again after an app restart.
 *
 * Key (normative, RANK.md §2.1): lowercase hex SHA-1 over UTF-8
 * ```
 * "scanlist-item-vector/1\n" + modelId + "\n" + dims + "\n" + docPrefix + "\n" + docText
 * ```
 * so changing the model, the active dims or the active prefix set invalidates every entry by
 * construction — there is no separate "invalidate" path and no key can be misread after a prefix A/B
 * flip. [prefixSet] (the `prompts.json` active set name) is kept for diagnostics only and does not
 * enter the key, because the key already hashes the prefix strings themselves.
 *
 * Stored values are **float64** (2048 B per 256-d vector): RANK.md §2 fixes all arithmetic to
 * float64, and a float32 round-trip would perturb a golden vector before the ranker ever sees it.
 * Values are stored as they arrive (already truncated + normalised, RANK.md §2); the cache never
 * re-normalises, so a hit is bit-identical to the value that was written.
 *
 * [dir] is a parameter (the app passes `filesDir/vectors/item-vectors`, a JVM test a temp dir), so
 * nothing here needs Android. Writes are atomic (temp file + fsync + rename), so a killed process
 * can never leave a half-written vector that a later run would read.
 */
class ItemVectorCache(
    val dir: File,
    val modelId: String,
    val dims: Int = RANK_DIMS_ACTIVE,
    val docPrefix: String,
    val prefixSet: String? = null,
    private val hotLimit: Int = 512,
) {
    init {
        require(dims > 0) { "dims must be positive" }
        require(dir.path.isNotEmpty()) { "cache dir must not be empty" }
    }

    /** Lowercase hex SHA-1 cache key for [docText] (RANK.md §2.1). */
    fun key(docText: String): String {
        val material = CACHE_KEY_SALT + modelId + "\n" + dims + "\n" + docPrefix + "\n" + docText
        return sha1Hex(material)
    }

    /** Cache file for [docText]. */
    fun fileFor(docText: String): File = File(dir, key(docText) + ".vec")

    /**
     * The cached vector for [docText], or `null` on a miss / unreadable entry (a corrupt or foreign
     * file is treated as a miss and removed so it is rewritten, never fatal).
     */
    fun get(docText: String): DoubleArray? {
        val key = key(docText)
        hot[key]?.let { return it }
        val file = File(dir, key + ".vec")
        if (!file.isFile) return null
        val vec = try {
            read(file, key)
        } catch (_: Exception) {
            null
        }
        if (vec == null) {
            file.delete()
            return null
        }
        remember(key, vec)
        return vec
    }

    /**
     * Store [vec] for [docText]. Returns false (and writes nothing) when the vector is not a valid
     * [dims]-length finite vector — an embedder failure must never poison the cache.
     */
    fun put(docText: String, vec: DoubleArray): Boolean {
        if (!isStorable(vec)) return false
        val key = key(docText)
        if (!dir.isDirectory && !dir.mkdirs()) return false
        val target = File(dir, key + ".vec")
        val temp = File.createTempFile(key + ".", TMP_SUFFIX, dir)
        try {
            FileOutputStream(temp).use { out ->
                val data = DataOutputStream(out)
                data.writeInt(MAGIC)
                data.writeInt(FORMAT_VERSION)
                data.writeInt(dims)
                data.writeUTF(key)
                for (v in vec) data.writeDouble(v)
                data.flush()
                out.fd.sync()
            }
            // File.renameTo is atomic on the same filesystem (and replaces on Linux/Android).
            if (!temp.renameTo(target)) {
                target.delete()
                check(temp.renameTo(target)) { "could not move ${temp.name} to ${target.name}" }
            }
        } finally {
            if (temp.exists()) temp.delete()
        }
        remember(key, vec)
        return true
    }

    /** Whether a valid vector is cached for [docText] (reads the file only to validate it). */
    fun contains(docText: String): Boolean = get(docText) != null

    /** Number of cached vectors, for diagnostics/logging. */
    fun size(): Int = dir.listFiles { f -> f.isFile && f.name.endsWith(VEC_SUFFIX) }?.size ?: 0

    /** Drop every cached vector (model/prefix change, a "rebuild index" action). */
    fun clear() {
        hot.clear()
        dir.listFiles()?.forEach { it.delete() }
    }

    private fun read(file: File, expectedKey: String): DoubleArray? {
        DataInputStream(ByteArrayInputStream(file.readBytes())).use { input ->
            if (input.readInt() != MAGIC) return null
            if (input.readInt() != FORMAT_VERSION) return null
            if (input.readInt() != dims) return null
            if (input.readUTF() != expectedKey) return null
            val vec = DoubleArray(dims) { input.readDouble() }
            return if (isStorable(vec)) vec else null
        }
    }

    private fun isStorable(vec: DoubleArray): Boolean {
        if (vec.size != dims) return false
        for (v in vec) if (!v.isFinite()) return false
        return true
    }

    private fun remember(key: String, vec: DoubleArray) {
        if (hotLimit <= 0) return
        if (hot.size >= hotLimit) hot.clear()
        hot[key] = vec
    }

    /** Session-level hot layer in front of the files; keeping 88 items in memory is trivial. */
    private val hot = ConcurrentHashMap<String, DoubleArray>()

    companion object {
        /** RANK.md §2.1 key salt — part of the normative key, never version-bump it in place. */
        const val CACHE_KEY_SALT: String = "scanlist-item-vector/1\n"

        /** The cache file extension; also what [size] counts. */
        const val VEC_SUFFIX: String = ".vec"

        private const val TMP_SUFFIX = ".tmp"
        private const val MAGIC = 0x534C5631 // "SLV1"
        private const val FORMAT_VERSION = 1

        /** The cache directory the app uses under its private files dir (derived data, ~2 KB/item). */
        fun defaultDir(filesDir: File): File = File(File(filesDir, "vectors"), "item-vectors")

        /** Lowercase hex SHA-1 over UTF-8 (the id + cache-key primitive, FLATTEN.md §3.2 / RANK.md §2.1). */
        fun sha1Hex(text: String): String {
            val digest = MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8))
            val out = StringBuilder(digest.size * 2)
            digest.forEach { byte ->
                val v = byte.toInt() and 0xff
                out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
            }
            return out.toString()
        }

        private const val HEX = "0123456789abcdef"
    }
}
