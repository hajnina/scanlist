package dev.hajnina.scanlist.embed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The self-test's reference (card S5): the bundled asset must be the CPU vectors for the bundle we
 * ship, and the 0.98 threshold must reject a backend that returns merely similar numbers.
 */
class GoldenVectorsTest {

    private fun bundledJson(): String = File("src/main/assets/embed_golden.json").readText()

    @Test
    fun bundledAssetIsTheReferenceForTheModelWeShip() {
        val golden = GoldenVectors.parse(bundledJson(), EmbedderConfig.DEFAULT_MODEL_SHA256)
        assertNotNull("golden asset is missing or for another sha256", golden)
        assertEquals(EmbedderConfig.DEFAULT_MODEL_SHA256, golden!!.sha256)
        assertEquals(768, golden["query"]!!.size)
        assertTrue(golden.vectors.keys.containsAll(listOf("query", "related", "unrelated", "tone")))
    }

    @Test
    fun aReferenceForAnotherModelFileIsRejected() {
        assertNull(GoldenVectors.parse(bundledJson(), "0000000000000000000000000000000000000000000000000000000000000000"))
        assertNotNull(GoldenVectors.parse(bundledJson(), null))
    }

    @Test
    fun equivalentOutputPassesAndWrongOutputFails() {
        val golden = GoldenVectors("sha", mapOf("query" to floatArrayOf(1f, 0f, 0f, 0f)))
        assertNull(golden.mismatch("query", floatArrayOf(1f, 0f, 0f, 0f)))
        // cosine 0.98 exactly passes (>= MIN_COSINE)
        val atThreshold = floatArrayOf(0.98f, kotlin.math.sqrt(1f - 0.98f * 0.98f), 0f, 0f)
        assertNull(golden.mismatch("query", atThreshold))
        val message = golden.mismatch("query", floatArrayOf(0f, 1f, 0f, 0f))
        assertNotNull(message)
        assertTrue(message!!.contains("cosine 0.0000"))
        assertTrue(message.contains("at least 0.98"))
    }

    @Test
    fun anInputWithoutAReferenceIsNotAFailure() {
        assertNull(GoldenVectors("sha", mapOf("query" to floatArrayOf(1f, 0f))).mismatch("tone", floatArrayOf(0f, 1f)))
    }

    @Test
    fun theSelfTestInputsMatchTheShippedGoldenKeys() {
        val golden = GoldenVectors.parse(bundledJson(), null)!!
        assertTrue(GoldenVectors.QUERY.isNotBlank())
        assertNotNull(golden["query"])
        assertNotNull(golden["related"])
        assertNotNull(golden["unrelated"])
    }
}
