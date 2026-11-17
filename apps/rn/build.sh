#!/usr/bin/env bash
# ScanList — Track A (React Native) Android build. Card A1.
#
#   apps/rn/build.sh [gradle-task]        # default: assembleDebug
#
# On this aarch64 laptop it sources scripts/android-env.sh (JAVA_HOME = Temurin 17, ANDROID_HOME,
# the aarch64 aapt2 override, shared GRADLE_USER_HOME, host-wide Gradle slot lock). On CI that
# script is a no-op, so the same command works on an x86_64 runner with the stock toolchain.
#
# Laptop-only overrides are passed as *arguments* (never baked into gradle files):
#   -Pandroid.aapt2FromMavenOverride=<aarch64 aapt2>    the Maven aapt2 is x86_64-only
#   -Pscanlist.ndkVersion=<aarch64 NDK>                 RN's default NDK 27 is x86_64-only
#   -PreactNativeArchitectures=arm64-v8a                one ABI instead of four (build time only)
#
# Everything else (versions, ids, signing) is the plain React Native project, so CI builds the
# same code. See BUILD.md for the full list of hacks and their status.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
task="${1:-assembleDebug}"

# --- 1. Android toolchain (no-op off the laptop) -------------------------------------------
if [ -f "$repo/scripts/android-env.sh" ]; then
    # shellcheck disable=SC1091
    . "$repo/scripts/android-env.sh"
fi

# scripts/android-env.sh exposes the *newest* build-tools aapt2. RN 0.88 needs build-tools 37
# (installed for this card) whose aapt2 is an x86_64 ELF, so on aarch64 re-select an aarch64
# aapt2 and drop the stale -D from GRADLE_OPTS (a general fix belongs in android-env.sh).
if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then
    aapt2_ok=0
    if [ -n "${ANDROID_AAPT2:-}" ] && file -b "$ANDROID_AAPT2" | grep -q 'ARM aarch64'; then
        aapt2_ok=1
    fi
    if [ "$aapt2_ok" = 0 ] && [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/build-tools" ]; then
        for candidate in $(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -name aapt2 | sort -V); do
            if file -b "$candidate" | grep -q 'ARM aarch64'; then
                export ANDROID_AAPT2="$candidate"
            fi
        done
    fi
    if [ -n "${ANDROID_AAPT2:-}" ]; then
        GRADLE_OPTS="$(printf '%s' "${GRADLE_OPTS:-}" | sed -E 's#-Dorg\.gradle\.project\.android\.aapt2FromMavenOverride=[^ ]*##')"
        export GRADLE_OPTS
        echo "build.sh: aarch64 aapt2 override $ANDROID_AAPT2"
    fi
fi

# --- 2. JS dependencies (node_modules is gitignored) ----------------------------------------
if [ ! -d "$here/node_modules/react-native" ]; then
    echo "build.sh: installing JS dependencies (one-off)"
    (cd "$here" && npm install --no-audit --no-fund)
fi

# --- 3. throwaway debug keystore (never committed) ------------------------------------------
bash "$here/scripts/make-debug-keystore.sh"

# --- 4. Gradle -------------------------------------------------------------------------------
cd "$here/android"

args=("$task")
# Heap: RN + AGP + Kotlin need more than the template default when driven through the shared
# Gradle slot lock (which would otherwise cap the daemon at 1.5 GB).
args+=("-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m")

if [ -n "${ANDROID_AAPT2:-}" ]; then
    args+=("-Pandroid.aapt2FromMavenOverride=$ANDROID_AAPT2")
fi

# Native (new-architecture) code is compiled by the app module's CMake build. Override the NDK
# only on an aarch64 host whose NDK actually ships linux-aarch64 prebuilts; CI keeps RN's default.
ndk_home="${ANDROID_NDK_HOME:-}"
if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then
    if [ -n "$ndk_home" ] && [ ! -d "$ndk_home/toolchains/llvm/prebuilt/linux-aarch64" ]; then
        ndk_home=""  # android-env defaults to NDK 27 when installed; it is x86_64-only
    fi
    if [ -z "$ndk_home" ] && [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
        # newest installed NDK that has an aarch64 LLVM toolchain (e.g. 30.0.16248370)
        for candidate in $(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V); do
            if [ -d "$candidate/toolchains/llvm/prebuilt/linux-aarch64" ]; then
                ndk_home="$candidate"
            fi
        done
    fi
fi
if [ -n "$ndk_home" ] && [ -d "$ndk_home/toolchains/llvm/prebuilt/linux-aarch64" ]; then
    ndk_version="$(basename "$ndk_home")"
    echo "build.sh: using aarch64-capable NDK $ndk_version (override; CI uses RN's default)"
    args+=("-Pscanlist.ndkVersion=$ndk_version")
    # One ABI is enough for a debug APK on a phone; CI builds all four.
    args+=("-PreactNativeArchitectures=arm64-v8a")
fi

if [ -n "${GRADLE_SLOT_SH:-}" ] && [ -x "${GRADLE_SLOT_SH}" ]; then
    GRADLE_BIN="$here/android/gradlew" "$GRADLE_SLOT_SH" "${args[@]}"
else
    "$here/android/gradlew" --no-daemon "${args[@]}"
fi

# --- 5. Report -------------------------------------------------------------------------------
apk="$here/android/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$apk" ]; then
    echo "build.sh: FAILED — no APK at $apk" >&2
    exit 1
fi
echo "build.sh: OK $(du -h "$apk" | cut -f1) $apk"
