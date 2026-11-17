// ScanList — Kotlin Compose app module (card B1).
//
// Layout and versions mirror references/bonsai-ui/src/bonsai-serve/app/build.gradle.kts
// (STYLE_GUIDE.md §1): AGP 8.7.3 + Kotlin 2.0.21 + material3 1.4.0 on compileSdk 35 is the pair
// that builds M3 Expressive on this aarch64 laptop toolchain and on the x86_64 CI runner.
//
// Plugin ids are applied WITHOUT versions: the repo-root build.gradle.kts (card S9) pins them,
// and the repo-root settings.gradle.kts maps the module id :scanlistKotlin to this directory.
// There is deliberately no settings.gradle.kts / gradlew / build.gradle.kts in apps/kotlin:
// that would create a second Gradle root (see S9 + B1 lead note).
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Throwaway debug signing key. app/scripts/make-debug-keystore.sh writes it to .signing/
// (gitignored, never committed); build.sh runs that script before Gradle. CI does not run the
// script, finds no file here and falls back to AGP's own debug keystore, so one build file works
// on both the laptop and the runner — no keystore, and no host path, in git or in Gradle.
val localDebugStore = file(".signing/debug.jks")

android {
    namespace = "dev.hajnina.scanlist.kotlin"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.hajnina.scanlist.kotlin"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (localDebugStore.isFile) {
            create("scanlistDebug") {
                storeFile = localDebugStore
                storePassword = "android"
                keyAlias = "scanlist"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        getByName("debug") {
            if (localDebugStore.isFile) signingConfig = signingConfigs.getByName("scanlistDebug")
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        // Card B3: this app now depends on :shared:android-embed, whose LiteRT-LM 0.18.1 dependency
        // is built with Kotlin 2.4 (metadata 2.4, stdlib 2.4 on the compile classpath) while the repo
        // pins Kotlin 2.0.21. Same workaround, same reason, as shared/android-embed/build.gradle.kts
        // (its README §"Kotlin metadata workaround"); it is needed on CI too, not a laptop override.
        freeCompilerArgs += "-Xskip-metadata-version-check"
    }
    buildFeatures { compose = true }
}

dependencies {
    // Pinned individually, like Bonsai, deliberately NOT via a Compose BOM: the BOM pulls ui 1.9
    // which needs compileSdk 36. material3 1.4.0 is the newest line that builds on compileSdk 35
    // (STYLE_GUIDE.md §1/§8); 1.5.x needs SDK 37 and is a later card.
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.runtime:runtime:1.9.0")
    implementation("androidx.compose.ui:ui:1.8.2")
    implementation("androidx.compose.foundation:foundation:1.8.2")
    implementation("androidx.compose.animation:animation:1.8.2")
    implementation("androidx.compose.material3:material3:1.4.0")

    // Card B2 (list import/export). kotlinx.serialization-json is pinned at module level (allowed by
    // the S9/B4 convention: "module-level dependency pins are fine; plugin pins are root-owned").
    // Only the JsonElement tree API is used, so the kotlinx.serialization COMPILER PLUGIN is not
    // needed — no root-owned plugin id has to change for this card.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Card B4 (camera scan sources): CameraX preview + one ImageAnalysis use case. Pinned
    // individually at module level like the rest of this file (allowed by the S9/B4 convention:
    // "module-level dependency pins are fine; plugin pins are root-owned"). 1.4.1 is the newest
    // CameraX line that builds on compileSdk 35 (1.5.x wants 36).
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

    // Card B4: ML Kit BUNDLED variants — the models ship inside the APK, so scanning works offline
    // and without Google Play Services. That is the point of "bundled": no Play-services dependency.
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("com.google.mlkit:text-recognition:16.0.1")

    // Card B2 Done-when: JVM unit tests for the parse/flatten/persist/export logic.
    // Card B4 Done-when: JVM unit tests for the scan-source logic with fake frames/clocks.
    testImplementation("junit:junit:4.13.2")

    // Card B3 (rank package): the shared EmbeddingGemma 2 seam — `Embedder`/`Embedders`/`Prompts`
    // from shared/android-embed (card S5). Disclosed in the B3 PR as the one build-file line the
    // rank package needs; no plugin or version pin changes.
    implementation(project(":shared:android-embed"))
}
