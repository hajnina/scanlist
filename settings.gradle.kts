// ScanList — root Gradle build (card S9).
//
// One Android Gradle root for the shared Kotlin library (shared/android-embed, card S5) and the
// Kotlin app (apps/kotlin, card B1). React Native keeps its own root at apps/rn/android, so it is
// deliberately NOT included here. Modelled on references/bonsai-ui/src/bonsai-serve/settings.gradle.kts
// (card S9 `reads:`).
//
// Modules are include-if-exists: this build is green with the root alone, and each module shows up
// as soon as the card that creates it lands — nothing to edit here.
//
// Chosen Kotlin app module id: :scanlistKotlin
//   * projectDir = apps/kotlin/app when apps/kotlin/app/build.gradle(.kts) exists
//     (Bonsai layout: apps/kotlin/build.gradle.kts pins plugins for a standalone build, the real
//     module is apps/kotlin/app — see references/bonsai-ui/src/bonsai-serve/app/build.gradle.kts);
//   * otherwise projectDir = apps/kotlin when only a build file there exists.
//   From the repo root: ./gradlew :scanlistKotlin:assembleDebug
//
// Plugin versions for those modules are pinned once in the root build.gradle.kts (apply false), so a
// module's own build file applies the ids *without* a version.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "scanlist"

// Include <projectPath> mapped to <moduleDir> only if that directory already has a build file.
// Intermediate projects (e.g. :shared) are created by Gradle automatically.
fun includeIfExists(projectPath: String, moduleDir: File): Boolean {
    if (!moduleDir.isDirectory) return false
    val hasBuildFile = listOf("build.gradle.kts", "build.gradle").any { File(moduleDir, it).isFile }
    if (!hasBuildFile) return false
    include(projectPath)
    project(projectPath).projectDir = moduleDir
    return true
}

// S5 — Kotlin library wrapping LiteRT-LM EmbeddingGemma 2.
includeIfExists(":shared:android-embed", file("shared/android-embed"))

// B1 — Compose app. Prefer the Bonsai app/ submodule layout, fall back to a build file in apps/kotlin.
if (!includeIfExists(":scanlistKotlin", file("apps/kotlin/app"))) {
    includeIfExists(":scanlistKotlin", file("apps/kotlin"))
}
