# ScanList shared/android-embed — consumer ProGuard/R8 rules (card S5).
#
# LiteRT-LM reaches its native layer through JNI and reflection over its Kotlin data classes, so its
# classes must keep their names and members. Mirrors the note in references/embeddinggemma/src/app/
# build.gradle.kts (MnemoThera keeps LiteRT-LM unminified).
-keep class com.google.ai.edge.litertlm.** { *; }
