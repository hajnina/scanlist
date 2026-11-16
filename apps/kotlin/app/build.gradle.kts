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
        minSdk = 30
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
    kotlinOptions { jvmTarget = "17" }
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
}
