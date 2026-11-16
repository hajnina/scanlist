plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose") }
android {
    namespace = "dev.hajnina.llmserve"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.hajnina.llmserve"
        minSdk = 30; targetSdk = 35
        versionCode = 1; versionName = "1.0"
    }
    signingConfigs { create("dbg") { storeFile = file("../debug.jks"); storePassword = "android"; keyAlias = "zen"; keyPassword = "android" } }
    buildTypes {
        debug { signingConfig = signingConfigs["dbg"] }
        release { signingConfig = signingConfigs["dbg"]; isMinifyEnabled = false }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { jniLibs { useLegacyPackaging = true } }
}
dependencies {
    // Material 3 Expressive: 1.4.0 = newest line that builds on compileSdk 35 (1.5.x needs 37). Pinned explicitly, no BOM (BOM pulls ui 1.9 = compileSdk 36).
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.runtime:runtime:1.9.0")
    implementation("androidx.compose.ui:ui:1.8.2")
    implementation("androidx.compose.foundation:foundation:1.8.2")
    implementation("androidx.compose.animation:animation:1.8.2")
    implementation("androidx.compose.material3:material3:1.4.0")
}
