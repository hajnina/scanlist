package dev.hajnina.scanlist.embed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

/**
 * Matryoshka truncation and L2 normalisation are the maths the whole ranking rests on: every vector a
 * scan compares must be 256-dim and unit length, or cosine stops being a dot product (card S5).
 */
class VectorsTest {

    @Test
    fun truncateKeepsTheFirstDimsInOrder() {
        val v = floatArrayOf(3f, 4f, 5f, 6f, 7f)
        assertArrayEquals(floatArrayOf(3f, 4f, 5f, 6f), Vectors.truncate(v, 4))
    }

    @Test
    fun normaliseMakesAUnitVector() {
        assertArrayEquals(floatArrayOf(0.6f, 0.8f), Vectors.normalize(floatArrayOf(3f, 4f)), 1e-6f)
        assertEquals(1f, Vectors.norm(Vectors.normalize(floatArrayOf(3f, 4f))), 1e-6f)
    }

    @Test
    fun truncateThenNormaliseIsWhatTheEmbedderReturns() {
        // 3-4-5-6 truncated to 2 is 3-4, normalised to 0.6-0.8; the discarded dims must not leak in.
        assertArrayEquals(floatArrayOf(0.6f, 0.8f), Vectors.truncateAndNormalize(floatArrayOf(3f, 4f, 5f, 6f), 2), 1e-6f)
    }

    @Test
    fun truncatingANative768VectorTo256GivesAUnit256Vector() {
        val native = FloatArray(768) { (it % 9 - 4).toFloat() }
        val active = Vectors.truncateAndNormalize(native, 256)
        assertEquals(256, active.size)
        assertEquals(1f, Vectors.norm(active), 1e-6f)
        assertEquals(Vectors.normalize(native.copyOf(256))[255], active[255], 1e-6f)
    }

    @Test
    fun aZeroVectorCannotBeNormalisedAndStaysZero() {
        val zeros = FloatArray(4)
        assertArrayEquals(zeros, Vectors.normalize(zeros))
        assertEquals(0f, Vectors.norm(zeros), 0f)
        assertEquals(-1f, Vectors.cosine(zeros, floatArrayOf(1f, 0f, 0f, 0f)), 0f)
    }

    @Test
    fun cosineOfIdenticalOrthogonalAndOppositeVectors() {
        val a = floatArrayOf(1f, 2f, 3f)
        assertEquals(1f, Vectors.cosine(a, a.copyOf()), 1e-6f)
        assertEquals(0f, Vectors.cosine(floatArrayOf(1f, 0f), floatArrayOf(0f, 1f)), 1e-6f)
        assertEquals(-1f, Vectors.cosine(floatArrayOf(1f, 0f), floatArrayOf(-1f, 0f)), 1e-6f)
    }

    @Test
    fun cosineRejectsASizeMismatchLikeTheReferenceImplementation() {
        assertEquals(-1f, Vectors.cosine(floatArrayOf(1f, 0f), floatArrayOf(1f, 0f, 0f)), 0f)
    }

    @Test
    fun dotIsCosineForUnitVectors() {
        val a = Vectors.normalize(floatArrayOf(3f, 4f))
        val b = Vectors.normalize(floatArrayOf(4f, -3f))
        assertEquals(Vectors.cosine(a, b), Vectors.dot(a, b), 1e-6f)
        assertEquals(0f, Vectors.dot(a, b), 1e-6f)
    }

    @Test
    fun truncateRefusesAnImpossibleSize() {
        assertThrows(IllegalArgumentException::class.java) { Vectors.truncate(floatArrayOf(1f, 2f), 3) }
        assertThrows(IllegalArgumentException::class.java) { Vectors.truncate(floatArrayOf(1f, 2f), 0) }
    }

    @Test
    fun normAccumulatesInDouble() {
        // 1000 dims of 1e4 would overflow a Float accumulator; the double one is exact to ~1e-7 relative.
        val big = FloatArray(1000) { 1e4f }
        val expected = 1e4f * sqrt(1000f)
        assertTrue(kotlin.math.abs(Vectors.norm(big) - expected) / expected < 1e-6f)
    }

    private fun assertArrayEquals(expected: FloatArray, actual: FloatArray, delta: Float = 0f) {
        assertEquals("size", expected.size, actual.size)
        for (i in expected.indices) assertEquals("index $i", expected[i], actual[i], delta)
    }

    private fun assertThrows(type: Class<out Throwable>, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            assertTrue("expected $type, got ${t.javaClass}", type.isInstance(t))
            return
        }
        throw AssertionError("expected $type, nothing thrown")
    }

    @Test
    fun cosineOfUnrelatedSentencesIsNotNearOne() {
        // Mirrors RECIPE.md §2: unrelated sentence pairs score ~0.75-0.89, so 0.98 only passes equivalent output.
        assertFalse(Vectors.cosine(floatArrayOf(1f, 0.8f), floatArrayOf(0.8f, 1f)) >= GoldenVectors.MIN_COSINE)
    }
}
