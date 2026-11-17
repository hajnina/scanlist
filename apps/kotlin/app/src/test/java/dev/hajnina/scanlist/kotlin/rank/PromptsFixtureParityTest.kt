package dev.hajnina.scanlist.kotlin.rank

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The golden/prefix PAIRING contract (shared/android-embed/README.md) as a TEST, not prose:
 * the bundled prompts asset the engine actually uses must agree with shared/spec/prompts.json
 * (the spec of record) and with the prefix set `shared/fixtures/golden.json` was recorded
 * under. If an A/B flips `active` in the spec without re-syncing the asset, or the fixture is
 * regenerated under a different set, this fails LOUDLY here instead of on a phone (B3 review:
 * the drift is otherwise invisible until SelfTest.prove() refuses every backend).
 */
class PromptsFixtureParityTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `bundled asset is byte-identical to the spec`() {
        assertEquals(
            "bundled prompts asset drifted from shared/spec/prompts.json — re-sync the asset",
            repoFile("shared/spec/prompts.json").readText(),
            repoFile("shared/android-embed/src/main/assets/prompts.json").readText(),
        )
    }

    @Test
    fun `spec active prefix set is the set golden json was recorded under`() {
        val spec = json.parseToJsonElement(repoFile("shared/spec/prompts.json").readText()).jsonObject
        val golden = json.parseToJsonElement(repoFile("shared/fixtures/golden.json").readText()).jsonObject

        val active = spec.string("active")
        val recorded = golden["prompts"]?.jsonObject
            ?: error("golden.json has no prompts block")

        assertEquals(
            "prompts.active does not match the prefix set golden.json was recorded under — " +
                "re-record goldens (S3 tooling) or re-pin the fixture",
            recorded.string("active"),
            active,
        )

        // The active set's prefixes in the spec must equal the ones the fixture recorded with.
        val set = spec[active]?.jsonObject ?: error("spec has no prefix set '$active'")
        assertEquals(recorded.string("doc"), set.string("doc"))
        assertEquals(recorded.string("query"), set.string("query"))
        assertEquals(recorded.string("image"), spec.string("imagePrefix"))
    }

    @Test
    fun `active output dim is the matryoshka 256 RANK section 2 mandates`() {
        val spec = json.parseToJsonElement(repoFile("shared/spec/prompts.json").readText()).jsonObject
        val dims = spec["dims"]?.jsonObject ?: error("spec has no dims block")
        assertEquals(256, dims.string("active").toInt())
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

// Top-level extension. NOTE: use `error(...)` (Nothing) for missing nodes, never
// org.junit.Assert.fail (void → Unit), or the elvis result stays nullable and the
// receiver type stops matching.
private fun JsonObject.string(key: String): String =
    (this[key] as? JsonPrimitive ?: error("missing string field '$key'")).content
