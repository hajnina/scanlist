#!/bin/bash
# usage: ./build.sh [assembleDebug|assembleRelease]
# Toolchain: ANDROID_TOOLCHAIN (default ~/projects/martins-whisper/android-toolchain) = dir with jdk/ (Temurin 17), gradle/gradle-8.9/, sdk/ (platform 35, build-tools 35.0.1 incl. the aarch64 aapt2).
# See RECOVERY.md "Phone app" for rebuilding that toolchain on a new machine. The shared gradle-slot lock is used when present, otherwise plain `gradle --no-daemon`.
T=${ANDROID_TOOLCHAIN:-/home/martin/projects/martins-whisper/android-toolchain}
export JAVA_HOME=${JAVA_HOME:-$T/jdk} ANDROID_HOME=${ANDROID_HOME:-$T/sdk} ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$T/sdk} GRADLE_USER_HOME=${GRADLE_USER_HOME:-$T/gradle-home}
export GRADLE_BIN=${GRADLE_BIN:-$T/gradle/gradle-8.9/bin/gradle}
SLOT=${GRADLE_SLOT:-/home/martin/projects/martins-whisper/owner/tools/gradle-slot.sh}
export GRADLE_SLOT_DIR=${GRADLE_SLOT_DIR:-/home/martin/projects/martins-whisper/.yoloseek/gradle-slots}
cd "$(dirname "$0")"
AAPT2=-Pandroid.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.1/aapt2
if [ -x "$SLOT" ]; then exec "$SLOT" $AAPT2 "${@:-assembleDebug}"; else exec "$GRADLE_BIN" --no-daemon $AAPT2 "${@:-assembleDebug}"; fi
