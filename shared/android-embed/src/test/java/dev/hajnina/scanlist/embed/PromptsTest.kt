package dev.hajnina.scanlist.embed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The prefixes and dims must come from `shared/spec/prompts.json` (bundled as the module asset), never
 * from hard-coded strings: card S3 flips `active` after the golden retrieval A/B and every consumer must
 * follow (card S5, docs/ARCHITECTURE.md).
 */
class PromptsTest {

    private fun bundledJson(): String {
        val file = File("src/main/assets/prompts.json")
        assertTrue("bundled asset missing: ${file.absolutePath}", file.isFile)
        return file.readText()
    }

    @Test
    fun bundledAssetUsesTheSpecDecisionAndDims() {
        val p = Prompts.parse(bundledJson())
        assertEquals("modelcard", p.active)
        assertEquals("title: none | text: ", p.docPrefix)
        assertEquals("task: search result | query: ", p.queryPrefix)
        assertEquals("", p.imagePrefix)
        assertEquals(768, p.nativeDims)
        assertEquals(256, p.activeDims)
        assertEquals(listOf(512, 256, 128), p.matryoshka)
        assertEquals("embeddinggemma-2-740m", p.model)
    }

    @Test
    fun switchingActiveToMnemotheraSwitchesThePrefixes() {
        val p = Prompts.parse(bundledJson().replace("\"active\": \"modelcard\"", "\"active\": \"mnemothera\""))
        assertEquals("mnemothera", p.active)
        assertEquals("task: search result | text: ", p.docPrefix)
        assertEquals("task: search query | text: ", p.queryPrefix)
    }

    @Test
    fun prefixThenTrimOnly_LeadingAndTrailingUnicodeWhitespace() {
        val p = Prompts.parse(bundledJson())
        assertEquals(p.docPrefix + "milk", p.doc("  milk \t\n"))
        assertEquals(p.docPrefix + "Oat Milk 3.5%", p.doc("Oat Milk 3.5%"))
        // no case folding, no punctuation stripping: the text after the prefix is untouched
        assertEquals(p.docPrefix + "MILK.", p.doc("MILK."))
        assertEquals(p.queryPrefix + "milk", p.query(" milk "))
    }

    @Test
    fun imagesTakeThePrefixFromTheFileWhichIsEmptyToday() {
        assertTrue(Prompts.parse(bundledJson()).image().isEmpty())
    }

    @Test
    fun anUnknownActiveSetIsAnErrorNotASilentFallback() {
        val json = bundledJson().replace("\"active\": \"modelcard\"", "\"active\": \"ollama\"")
        val failure = runCatching { Prompts.parse(json) }.exceptionOrNull()
        assertTrue("expected IllegalArgumentException, got $failure", failure is IllegalArgumentException)
        assertTrue(failure!!.message.orEmpty().contains("unknown prefix set"))
    }

    @Test
    fun aMissingPrefixSetIsAnError() {
        val json = """{"active":"mnemothera","dims":{"native":768,"active":256}}"""
        assertTrue(runCatching { Prompts.parse(json) }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun aFileWithoutActiveDefaultsToTheModelCardSet() {
        val json = """{"dims":{"native":768,"active":256},"mnemothera":{"doc":"m-doc","query":"m-query"},"modelcard":{"doc":"mc-doc","query":"mc-query"}}"""
        val p = Prompts.parse(json)
        assertEquals("modelcard", p.active)
        assertEquals("mc-doc", p.docPrefix)
        assertEquals(listOf(512, 256, 128), p.matryoshka)
    }
}
