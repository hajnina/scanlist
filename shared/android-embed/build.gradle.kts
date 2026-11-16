// ScanList — shared/android-embed: EmbeddingGemma 2 behind one small Kotlin interface (card S5).
//
// Plugin versions are pinned once in the repo root build.gradle.kts (apply false), so nothing here
// carries a version. The module is picked up by the root settings.gradle.kts include-if-exists.
//
// LiteRT-LM: com.google.ai.edge.litertlm:litertlm-android:0.18.1 is the version MnemoThera measured on
// three phones (references/embeddinggemma/RECIPE.md §1/§7). It already ships the vision API
// (EmbeddingEngineConfig.visionBackend / visionTokensPerImage, InputData.Image) that 0.19.1 was
// researched for, so no version bump was needed — verified with javap against the local Maven cache
// for both versions (identical constructor/getter shape).
//
// NOTE ON KOTLIN 2.4 METADATA: litertlm-android 0.18.1 is built with Kotlin 2.4 (kotlin.Metadata
// mv=[2,4,0]; POM wants kotlin-reflect 2.4.0), while the root pins Kotlin 2.0.21 for the whole repo.
// `-Xskip-metadata-version-check` lets the 2.0.21 compiler read it; the real fix is a root Kotlin bump
// (lead-owned) once CI proves this module. Details in README.md §"LiteRT-LM version decision".
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.hajnina.scanlist.embed"
    compileSdk = 35

    defaultConfig {
        // LiteRT-LM 0.18.1 requires Android 12 / API 31 (RECIPE.md §4).
        minSdk = 31
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        // See the header: LiteRT-LM's metadata is 2.4, the repo's Kotlin is 2.0.21.
        freeCompilerArgs += "-Xskip-metadata-version-check"
    }

    buildFeatures {
        buildConfig = false
    }

    testOptions {
        unitTests {
            // JVM tests are pure Kotlin + a fake engine: no Robolectric, no android.* calls.
            isReturnDefaultValues = true
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // The engine (Kotlin API + native libraries for CPU/GPU; GPU needs OpenCL, see AndroidManifest.xml).
    api("com.google.ai.edge.litertlm:litertlm-android:0.18.1")
    // JSON for the bundled prompts.json / embed_golden.json. Already on LiteRT-LM's compile path,
    // declared explicitly because this module parses assets itself.
    implementation("com.google.code.gson:gson:2.14.0")

    testImplementation("junit:junit:4.13.2")
}
