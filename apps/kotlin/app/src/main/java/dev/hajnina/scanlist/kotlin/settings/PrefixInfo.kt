package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.Prompts

/**
 * The prefix set the app is actually embedding with, for the settings screen ("prefix set display",
 * card B6). Read from the bundled `prompts.json` — the same asset [dev.hajnina.scanlist.embed.LiteRtEmbedder]
 * reads — so this class hard-codes no prefix (docs/ARCHITECTURE.md: "they live in
 * shared/spec/prompts.json, never hard-coded"). A flip of `active` in the spec shows up here after
 * the asset is re-synced, with no code change.
 */
data class PrefixInfo(
    val active: String,
    val version: Int,
    val model: String,
    val docPrefix: String,
    val queryPrefix: String,
    val imagePrefix: String,
    val dims: Int,
    val nativeDims: Int,
) {
    /** "mnemothera · v1 · 768→256" */
    fun summary(): String = "$active · v$version · $nativeDims→$dims"

    /** The doc prefix with invisible whitespace made explicit. */
    fun doc(): String = describe(docPrefix)

    /** The query prefix with invisible whitespace made explicit. */
    fun query(): String = describe(queryPrefix)

    /** Images take no prefix today; say so instead of showing an empty string. */
    fun image(): String = if (imagePrefix.isEmpty()) "none (raw image)" else describe(imagePrefix)

    companion object {
        fun from(prompts: Prompts): PrefixInfo = PrefixInfo(
            active = prompts.active,
            version = prompts.version,
            model = prompts.model,
            docPrefix = prompts.docPrefix,
            queryPrefix = prompts.queryPrefix,
            imagePrefix = prompts.imagePrefix,
            dims = prompts.activeDims,
            nativeDims = prompts.nativeDims,
        )
    }
}

/**
 * Prefixes are "prefix + trim(text)", so a trailing space inside the prefix is load-bearing and
 * invisible in a monospace line. Quote it and name the trailing space instead of letting the reader
 * guess; an empty prefix is called empty, not rendered as a blank row.
 */
fun describe(prefix: String): String = when {
    prefix.isEmpty() -> "empty"
    prefix.endsWith(" ") -> "\"$prefix\" · trailing space"
    else -> "\"$prefix\""
}
