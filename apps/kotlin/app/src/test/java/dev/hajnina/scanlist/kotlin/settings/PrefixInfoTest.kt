package dev.hajnina.scanlist.kotlin.settings

import dev.hajnina.scanlist.embed.Prompts
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Card B6 "prefix set display": the screen must show the prefixes the embedder is actually using, read
 * from the bundled prompts.json — this test pins the display to the spec of record and proves nothing
 * is hard-coded (flip `active` in the spec and the display follows).
 */
class PrefixInfoTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `the display follows prompts json, not a hard-coded prefix set`() {
        val spec = json.parseToJsonElement(repoFile("shared/spec/prompts.json").readText()).jsonObject
        val prompts = Prompts.parse(repoFile("shared/spec/prompts.json").readText())
        val info = PrefixInfo.from(prompts)

        val activeSet = spec[info.active]?.jsonObject ?: error("spec has no set '${info.active}'")
        assertEquals(spec.string("active"), info.active)
        assertEquals(activeSet.string("doc"), info.docPrefix)
        assertEquals(activeSet.string("query"), info.queryPrefix)
        assertEquals(spec.string("imagePrefix"), info.imagePrefix)
        assertEquals("embeddinggemma-2-740m", info.model)
        assertEquals(1, info.version)
    }

    @Test
    fun `dims and summary match the matryoshka contract`() {
        val info = PrefixInfo.from(Prompts.parse(repoFile("shared/spec/prompts.json").readText()))
        assertEquals(768, info.nativeDims)
        assertEquals(256, info.dims)
        assertTrue(info.summary(), info.summary().startsWith(info.active))
        assertTrue(info.summary(), info.summary().contains("768→256"))
        assertTrue(info.summary(), info.summary().contains("v1"))
    }

    @Test
    fun `prefixes are shown with their invisible whitespace called out`() {
        val info = PrefixInfo.from(Prompts.parse(repoFile("shared/spec/prompts.json").readText()))
        // Both shipped sets end in a space (prefix + trim(text)); the display must say so.
        assertTrue(info.doc(), info.doc().contains("trailing space"))
        assertTrue(info.query(), info.query().contains("trailing space"))
        assertTrue(info.doc().startsWith("\""))
        assertEquals("none (raw image)", info.image())
    }

    @Test
    fun `describe is explicit about empty and trailing-space prefixes`() {
        assertEquals("empty", describe(""))
        assertEquals("\"task: x | text: \" · trailing space", describe("task: x | text: "))
        assertEquals("\"prefix\"", describe("prefix"))
    }

    @Test
    fun `the bundled android-embed asset agrees with the display source`() {
        // The screen reads whatever asset the embedder reads; here the repo copy of that asset.
        val asset = Prompts.parse(repoFile("shared/android-embed/src/main/assets/prompts.json").readText())
        val info = PrefixInfo.from(asset)
        assertEquals(asset.active, info.active)
        assertEquals(asset.docPrefix, info.docPrefix)
        assertFalse(info.docPrefix.isEmpty())
        assertFalse(info.queryPrefix.isEmpty())
    }

    private fun repoFile(relative: String): File {
        var candidate: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (candidate != null) {
            val file = File(candidate, relative)
            if (file.isFile) return file
            candidate = candidate.parentFile
        }
        error("could not find $relative above ${System.getProperty("user.dir")}")
    }
}

private fun JsonObject.string(key: String): String =
    (this[key] as? JsonPrimitive ?: error("missing string field '$key'")).content
