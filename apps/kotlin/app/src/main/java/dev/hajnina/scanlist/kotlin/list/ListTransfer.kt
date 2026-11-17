package dev.hajnina.scanlist.kotlin.list

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.util.Locale

// Android I/O adapters only: SAF reads/writes and the share sheet. All parsing, validating,
// ticking and JSON encoding lives in ListJson / ListRepository / ListEdit, which are plain Kotlin
// and unit-tested on the JVM (card B2 Done-when). Nothing here needs a manifest permission: the
// Storage Access Framework grants per-file access, and ACTION_SEND carries the JSON as text so no
// FileProvider is needed either.

object ListTransfer {

    const val MIME_JSON = "application/json"

    /** Read a SAF document as UTF-8 text. Failures are returned, never thrown into the UI. */
    fun read(context: Context, uri: Uri): Result<String> = runCatching {
        val stream = context.contentResolver.openInputStream(uri)
            ?: error("cannot open the selected file")
        stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    /** Write exported JSON to a SAF document (the ACTION_CREATE_DOCUMENT result). */
    fun write(context: Context, uri: Uri, json: String): Result<Unit> = runCatching {
        val stream = context.contentResolver.openOutputStream(uri, "wt")
            ?: error("cannot write the selected file")
        stream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
    }

    /** "Van weekly shop" -> "van-weekly-shop.json" (the suggested file name on export). */
    fun fileNameFor(title: String): String {
        val slug = title.trim().lowercase(Locale.ROOT)
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .ifEmpty { "scanlist" }
        return "$slug.json"
    }

    /** Share sheet with the JSON as text plus a suggested file name (no FileProvider needed). */
    fun shareIntent(json: String, title: String): Intent = Intent(Intent.ACTION_SEND).apply {
        type = MIME_JSON
        putExtra(Intent.EXTRA_TEXT, json)
        putExtra(Intent.EXTRA_TITLE, fileNameFor(title))
        putExtra(Intent.EXTRA_SUBJECT, title)
    }

    fun share(context: Context, json: String, title: String) {
        val chooser = Intent.createChooser(shareIntent(json, title), "Export list").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }

    fun copy(context: Context, json: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("ScanList JSON", json))
    }

    /** Picker filter: some file managers label .json as octet-stream, so accept everything. */
    val IMPORT_MIME_TYPES = arrayOf("*/*")
}
