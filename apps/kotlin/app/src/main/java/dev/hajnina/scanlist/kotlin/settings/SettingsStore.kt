package dev.hajnina.scanlist.kotlin.settings

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * The one settings preference that must survive a restart: the embedding backend choice (card B6).
 *
 * One small UTF-8 JSON document at `<filesDir>/settings/embedding.json`, written atomically
 * (tmp + rename), the same plain-java.io approach card B2 chose for [dev.hajnina.scanlist.kotlin.list.ListStore]
 * and for the same reasons: a few bytes do not justify a DataStore dependency, the file is
 * inspectable, and the whole store is JVM-unit-testable.
 *
 * A missing, empty or corrupt file means "never chosen" → [BackendChoice.DEFAULT]. A settings file
 * must never brick the app, so reading never throws.
 */
class SettingsStore(private val root: File) {

    /** `<root>/settings/embedding.json` — `root` is the app's files dir on device. */
    val file: File get() = File(File(root, "settings"), FILE_NAME)

    fun backend(): BackendChoice {
        val text = if (file.isFile) runCatching { file.readText(Charsets.UTF_8) }.getOrNull() else null
        return parse(text)
    }

    /** Persist [choice] atomically; returns the file written. */
    fun setBackend(choice: BackendChoice): File {
        val target = file
        target.parentFile?.mkdirs()
        val document = buildJsonObject {
            put("version", VERSION)
            putJsonObject("embedding") { put("backend", choice.id) }
        }
        val text = Json { prettyPrint = true }.encodeToString(JsonObject.serializer(), document) + "\n"
        val tmp = File(target.parentFile, "$FILE_NAME.tmp")
        tmp.writeText(text, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            // renameTo can fail across mounts; fall back to a copy + delete, as ListStore does.
            target.writeText(text, Charsets.UTF_8)
            tmp.delete()
        }
        return target
    }

    /** Pure parse of a stored document; any shape problem falls back to [BackendChoice.DEFAULT]. */
    internal fun parse(text: String?): BackendChoice {
        if (text.isNullOrBlank()) return BackendChoice.DEFAULT
        return runCatching {
            val document = Json.parseToJsonElement(text).jsonObject
            val embedding = document["embedding"]?.jsonObject ?: return@runCatching BackendChoice.DEFAULT
            val id = (embedding["backend"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            BackendChoice.fromId(id)
        }.getOrDefault(BackendChoice.DEFAULT)
    }

    companion object {
        const val FILE_NAME = "embedding.json"
        const val VERSION = 1

        /** Standard location: `<filesDir>/settings/embedding.json`. */
        fun forFilesDir(filesDir: File): SettingsStore = SettingsStore(filesDir)
    }
}
