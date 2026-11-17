package dev.hajnina.scanlist.kotlin.list

import java.io.File
import org.junit.Assert.fail

/**
 * Locates `shared/spec/samples/` (the fixtures the card's Done-when names) from a JVM unit test,
 * whose working directory is the Gradle module dir (`apps/kotlin/app`). Walks up until the repo
 * root is found and fails loudly rather than silently skipping a test.
 */
object Samples {
    val dir: File by lazy {
        var candidate: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (candidate != null) {
            val samples = File(candidate, "shared/spec/samples")
            if (samples.isDirectory) return@lazy samples
            candidate = candidate.parentFile
        }
        fail("could not find shared/spec/samples above ${System.getProperty("user.dir")}")
        error("unreachable")
    }

    fun files(): List<File> = dir.listFiles()
        ?.filter { it.isFile && it.name.endsWith(".json") }
        ?.sortedBy { it.name }
        .orEmpty()

    fun read(name: String): String = File(dir, name).readText(Charsets.UTF_8)

    fun requireAll(): List<Pair<String, String>> {
        val files = files()
        check(files.size == 4) { "expected the 4 shared samples, found ${files.map { it.name }}" }
        return files.map { it.name to it.readText(Charsets.UTF_8) }
    }
}
