// ScanList — root build: plugin versions for every Android module (card S9).
//
// Mirrors references/bonsai-ui/src/bonsai-serve/build.gradle.kts: AGP 8.7.3 + Kotlin 2.0.21 is the
// pair the Bonsai app builds material3 1.4.0 (M3 Expressive, compileSdk 35) with, and it matches the
// aarch64 laptop toolchain (Gradle 8.9/JDK 17) in scripts/android-env.sh.
//
// Modules apply these ids WITHOUT a version, e.g.:
//   shared/android-embed/build.gradle.kts (S5):
//     plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
//   apps/kotlin/app/build.gradle.kts (B1):
//     plugins {
//         id("com.android.application")
//         id("org.jetbrains.kotlin.android")
//         id("org.jetbrains.kotlin.plugin.compose")
//     }
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
