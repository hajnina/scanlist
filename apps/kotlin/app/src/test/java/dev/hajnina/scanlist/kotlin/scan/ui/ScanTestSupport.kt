package dev.hajnina.scanlist.kotlin.scan.ui

import dev.hajnina.scanlist.kotlin.list.FlatItem
import java.io.File
import org.junit.Assert.fail

/** Locates a repo-relative file from the Gradle test working directory (same walk as `Golden`). */
fun repoFile(relative: String): File {
    var candidate: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (candidate != null) {
        val file = File(candidate, relative)
        if (file.isFile) return file
        candidate = candidate.parentFile
    }
    fail("could not find $relative above ${System.getProperty("user.dir")}")
    throw AssertionError("unreachable")
}

/** A flattened item without the parts ranking does not read (amounts/notes/aliases stay empty). */
fun flatItem(
    id: String,
    name: String,
    order: Int = 0,
    done: Boolean = false,
    path: List<String> = listOf("Pantry"),
): FlatItem = FlatItem(
    id = id,
    name = name,
    amount = null,
    unit = null,
    note = null,
    aliases = emptyList(),
    done = done,
    path = path,
    pathText = path.joinToString(" > "),
    index = 0,
    order = order,
)

/** Unit vectors along the axes: `axis(0)` = (1,0,0,0), `axis(1)` = (0,1,0,0) … (dims = 4 in tests). */
fun axis(index: Int, dims: Int = 4): DoubleArray = DoubleArray(dims).also { it[index] = 1.0 }

/**
 * Deterministic [QueryEmbedder]: text → the vector registered for it (a zero vector otherwise, which
 * scores 0 against everything), image → the configured function. Records every call so a test can
 * assert *what* was embedded and how often (the query cache's whole point).
 */
class FakeQueryEmbedder(
    override val dims: Int = 4,
    private val textVectors: Map<String, DoubleArray> = emptyMap(),
    private val imageVectors: (ByteArray) -> DoubleArray? = { null },
) : QueryEmbedder {
    val textRequests = mutableListOf<String>()
    val imageRequests = mutableListOf<ByteArray>()

    override var error: String? = null

    override fun text(text: String): DoubleArray? {
        textRequests += text
        return textVectors[text] ?: DoubleArray(dims)
    }

    override fun image(jpeg: ByteArray): DoubleArray? {
        imageRequests += jpeg
        return imageVectors(jpeg)
    }
}

/** Records the degrees it was asked to rotate (and hands the bytes back so the flow continues). */
class RecordingRotator(
    private val result: (ByteArray, Int) -> ByteArray? = { jpeg, _ -> jpeg },
) : ImageRotator {
    val calls = mutableListOf<Int>()
    val inputs = mutableListOf<ByteArray>()

    override fun rotateClockwise(jpeg: ByteArray, degrees: Int): ByteArray? {
        calls += degrees
        inputs += jpeg
        return result(jpeg, degrees)
    }
}
