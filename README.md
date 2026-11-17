# ScanList

[![PR build](https://github.com/hajnina/scanlist/actions/workflows/pr.yml/badge.svg)](https://github.com/hajnina/scanlist/actions/workflows/pr.yml)
[![ScanList (rolling)](https://img.shields.io/badge/release-rolling-blue)](https://github.com/hajnina/scanlist/releases/tag/rolling)

Shopping list from nested JSON (section → item → amount) with a **magic scanner**: point the phone at a product and
EmbeddingGemma 2 (text + image embeddings, on-device GPU/CPU/NPU or on a server) sorts the list by similarity so you tick it off fast.

Three implementations, compared: `apps/kotlin` (Compose), `apps/rn` (React Native), `apps/web` (browser + FastAPI server).

- Architecture: `docs/ARCHITECTURE.md` · Plan: `docs/PLAN.md` · List format: `docs/list.schema.json`
- Kanban: `kanban/README.md`, `python3 kanban/board.py`
- References (read-only copies): `references/embeddinggemma/RECIPE.md` (from MnemoThera / Therapy_local),
  `references/bonsai-ui/STYLE_GUIDE.md` (from Bonsai Serve), `references/REFERENCES.md`

## Android builds (aarch64 laptop)

This machine is aarch64, so the x86_64 aapt2 that Gradle downloads from Maven cannot run. Instead of hacking
`gradle.properties`, every build sources one script that points at the shared toolchain in
`~/projects/martins-whisper/android-toolchain` (Temurin 17, Gradle 8.9, SDK platform 35, an aarch64 aapt2):

```sh
source scripts/android-env.sh

scanlist_gradle :app:assembleDebug   # recommended: shared build-slot lock, --no-daemon, aapt2 override
./gradlew :app:assembleDebug         # also works, the override arrives as a Gradle project property
```

It exports `JAVA_HOME`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, `GRADLE_USER_HOME`, `GRADLE_BIN`,
`ANDROID_AAPT2` and `GRADLE_OPTS=-Dorg.gradle.project.android.aapt2FromMavenOverride=<aarch64 aapt2>`, and adds the
JDK, Gradle, adb and build-tools to `PATH`. Overrides: `ANDROID_TOOLCHAIN`, `SCANLIST_BUILD_TOOLS`,
`SCANLIST_NDK_VERSION`, `GRADLE_USER_HOME`. Sourcing it twice is harmless, and on a normal x86_64 machine (CI) it
does nothing except print a note — laptop-only settings never live in the Gradle files.
Native (NDK/CMake) builds are **not** supported on this host yet: the installed NDKs only contain a linux-x86_64
prebuilt toolchain. `bash scripts/android-env.sh` prints what was resolved without exporting it.
