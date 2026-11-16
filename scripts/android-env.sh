#!/usr/bin/env bash
# ScanList — aarch64 Android build environment (card S7).
#
# The laptop this project is built on is aarch64 Linux, so the Android SDK that Gradle
# downloads (build-tools' aapt2 binary is x86_64) does not run. The shared hand-built
# toolchain at ~/projects/martins-whisper/android-toolchain provides an aarch64 aapt2
# (plus Temurin 17, Gradle 8.9, platform 35, NDK, a shared GRADLE_USER_HOME); this script
# exports the same variables Bonsai Serve's build.sh does, so every track builds with:
#
#     source scripts/android-env.sh
#     scanlist_gradle :app:assembleDebug      # or ./gradlew ... (aapt2 is already exported)
#
# Modelled on references/bonsai-ui/src/bonsai-serve/build.sh (card S7 `reads:`):
#   JAVA_HOME / ANDROID_HOME / ANDROID_SDK_ROOT / GRADLE_USER_HOME / GRADLE_BIN and
#   -Pandroid.aapt2FromMavenOverride=<aarch64 aapt2>, via the shared gradle-slot lock
#   when it exists, else plain `gradle --no-daemon`.
#
# Properties:
#   * source-able and idempotent — sourcing it twice changes nothing (PATH is de-duplicated).
#   * never fails the caller: it is safe under `set -euo pipefail`.
#   * on a machine without the toolchain (e.g. the x86_64 GitHub CI runner) it leaves the
#     environment untouched and prints one note to stderr, so CI uses the Maven aapt2 and
#     the normal SDK. Nothing here is baked into gradle.properties for that reason.
#   * does NOT write to the toolchain; nothing needs sudo.
#
# Overridable (set before sourcing, all optional):
#   ANDROID_TOOLCHAIN     toolchain root          (default ~/projects/martins-whisper/android-toolchain)
#   JAVA_HOME             JDK to use              (default $ANDROID_TOOLCHAIN/jdk)
#   SCANLIST_BUILD_TOOLS  build-tools version dir (default: newest installed, usually 35.0.1)
#   SCANLIST_NDK_VERSION  NDK version dir         (default 27.0.12077973 — AGP 8.7's default — else newest)
#   GRADLE_USER_HOME      Gradle home             (default $ANDROID_TOOLCHAIN/gradle-home)
#   GRADLE_SLOT_SH        shared build lock       (default ~/projects/martins-whisper/owner/tools/gradle-slot.sh)
#   SCANLIST_ANDROID_ENV_VERBOSE=1  print what was set (also printed when run as a script)

_scanlist_path_add() {
    # Add $1 to PATH once (front), keep it quiet if the dir does not exist.
    [ -n "$1" ] && [ -d "$1" ] || return 0
    case ":$PATH:" in
        *":$1:"*) ;;
        *) PATH="$1:$PATH" ;;
    esac
}

_scanlist_latest_dir() {
    # newest version-named subdirectory of $1 (sort -V), empty when none
    [ -d "$1" ] || return 0
    { find "$1" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -V | tail -n 1; } || true
}

_scanlist_android_env() {
    local T="${ANDROID_TOOLCHAIN:-$HOME/projects/martins-whisper/android-toolchain}"
    export ANDROID_TOOLCHAIN="$T"

    if [ ! -d "$T" ]; then
        printf 'android-env: %s not found — leaving SDK/JDK env untouched (CI/other host: Maven aapt2 will be used)\n' "$T" >&2
        return 0
    fi

    # --- JDK 17 (Temurin) ---------------------------------------------------------------
    if [ -z "${JAVA_HOME:-}" ] && [ -x "$T/jdk/bin/java" ]; then
        export JAVA_HOME="$T/jdk"
    fi
    if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
        _scanlist_path_add "$JAVA_HOME/bin"
    fi

    # AGP 8.7 / Gradle 8.9 need JDK 17: warn (don't override a deliberate JAVA_HOME) if the
    # JDK in play is something else, e.g. a stray system Java 25 on this laptop.
    if [ -n "${JAVA_HOME:-}" ] && [ "$JAVA_HOME" != "$T/jdk" ]; then
        local jv=""
        jv="$(java -version 2>&1)" || jv=""
        jv="${jv%%$'\n'*}"
        case "$jv" in
            *'"17.'*) ;;
            *) printf 'android-env: warning: %s reports %s — AGP 8.7/Gradle 8.9 expect JDK 17 (Temurin 17 is at %s/jdk)\n' \
                   "$JAVA_HOME" "${jv:-unknown version}" "$T" >&2 ;;
        esac
    fi

    # --- SDK ----------------------------------------------------------------------------
    export ANDROID_HOME="${ANDROID_HOME:-$T/sdk}"
    export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
    _scanlist_path_add "$ANDROID_HOME/platform-tools"
    _scanlist_path_add "$ANDROID_HOME/cmdline-tools/latest/bin"

    # build-tools dir (aapt2/apksigner/adb helpers) — newest, or SCANLIST_BUILD_TOOLS
    local bt="${SCANLIST_BUILD_TOOLS:-}"
    if [ -z "$bt" ]; then
        bt="$(_scanlist_latest_dir "$ANDROID_HOME/build-tools")"
    fi
    if [ -n "$bt" ] && [ -d "$ANDROID_HOME/build-tools/$bt" ]; then
        export SCANLIST_BUILD_TOOLS="$bt"
        _scanlist_path_add "$ANDROID_HOME/build-tools/$bt"
    fi

    # --- aarch64 aapt2 override (the whole point of the toolchain) ----------------------
    # Gradle's Maven build-tools ship an x86_64 aapt2 and die with "Exec format error" here.
    local aapt2=""
    if [ -n "${ANDROID_AAPT2:-}" ]; then
        aapt2="$ANDROID_AAPT2"
    elif [ -n "$bt" ] && [ -x "$ANDROID_HOME/build-tools/$bt/aapt2" ]; then
        aapt2="$ANDROID_HOME/build-tools/$bt/aapt2"
    fi
    if [ -n "$aapt2" ] && [ -x "$aapt2" ]; then
        export ANDROID_AAPT2="$aapt2"
        # Belt and braces so a plain `gradle`/`./gradlew` also sees it: Gradle turns
        # -Dorg.gradle.project.<name>=<value> into a project property, and both launchers
        # read GRADLE_OPTS (dotted env var names like ORG_GRADLE_PROJECT_x.y are illegal in bash).
        case " ${GRADLE_OPTS:-} " in
            *"-Dorg.gradle.project.android.aapt2FromMavenOverride="*) ;;
            *) GRADLE_OPTS="${GRADLE_OPTS:+$GRADLE_OPTS }-Dorg.gradle.project.android.aapt2FromMavenOverride=$aapt2" ;;
        esac
        export GRADLE_OPTS
        export SCANLIST_AAPT2_ARG="-Pandroid.aapt2FromMavenOverride=$aapt2"
    else
        printf 'android-env: no executable aapt2 under %s/build-tools/%s — builds will use Maven aapt2 (fails on aarch64)\n' \
            "$ANDROID_HOME" "$bt" >&2
    fi

    # --- NDK ----------------------------------------------------------------------------
    # AGP 8.7 defaults to 27.0.12077973; the toolchain also has 30.x. NB: these NDKs only
    # ship a linux-x86_64 prebuilt LLVM toolchain, so *native C/C++* builds (CMake/ndk-build)
    # will not run on this aarch64 host yet — Kotlin/Java-only modules are unaffected.
    local ndk_root="$ANDROID_HOME/ndk" ndkv="${SCANLIST_NDK_VERSION:-}"
    if [ -d "$ndk_root" ]; then
        export ANDROID_NDK="$ndk_root"
        if [ -z "$ndkv" ]; then
            if [ -d "$ndk_root/27.0.12077973" ]; then
                ndkv=27.0.12077973
            else
                ndkv="$(_scanlist_latest_dir "$ndk_root")"
            fi
        fi
        if [ -n "$ndkv" ] && [ -d "$ndk_root/$ndkv" ]; then
            export SCANLIST_NDK_VERSION="$ndkv"
            export ANDROID_NDK_HOME="$ndk_root/$ndkv"
            export ANDROID_NDK_ROOT="$ndk_root/$ndkv"
            export NDK_HOME="$ndk_root/$ndkv"
        fi
    fi

    # --- Gradle -------------------------------------------------------------------------
    # One shared GRADLE_USER_HOME so dependency caches are reused across tracks/worktrees.
    if [ -z "${GRADLE_USER_HOME:-}" ] && [ -d "$T/gradle-home" ]; then
        export GRADLE_USER_HOME="$T/gradle-home"
    fi
    if [ -z "${GRADLE_BIN:-}" ]; then
        if [ -x "$T/gradle/current/bin/gradle" ]; then
            export GRADLE_BIN="$T/gradle/current/bin/gradle"
        elif [ -x "$T/gradle/gradle-8.9/bin/gradle" ]; then
            export GRADLE_BIN="$T/gradle/gradle-8.9/bin/gradle"
        fi
    fi
    if [ -n "${GRADLE_BIN:-}" ]; then
        _scanlist_path_add "$(dirname "$GRADLE_BIN")"
    fi

    # Shared host-wide Gradle slot lock: several agents build in parallel on this laptop,
    # so we take a slot (no daemons, capped heap) instead of each spawning a 3 GB JVM.
    if [ -z "${GRADLE_SLOT_SH:-}" ] && [ -x "$HOME/projects/martins-whisper/owner/tools/gradle-slot.sh" ]; then
        export GRADLE_SLOT_SH="$HOME/projects/martins-whisper/owner/tools/gradle-slot.sh"
    fi
    if [ -z "${GRADLE_SLOT_DIR:-}" ] && [ -d "$HOME/projects/martins-whisper/.yoloseek/gradle-slots" ]; then
        export GRADLE_SLOT_DIR="$HOME/projects/martins-whisper/.yoloseek/gradle-slots"
    fi

    export PATH
}

# Gradle with this toolchain: --no-daemon, the aarch64 aapt2 override, through the shared
# slot lock when available. Use exactly like `gradle`, e.g.:
#   scanlist_gradle :app:assembleDebug
scanlist_gradle() {
    local -a a=()
    [ -n "${ANDROID_AAPT2:-}" ] && a+=("-Pandroid.aapt2FromMavenOverride=$ANDROID_AAPT2")
    if [ -n "${GRADLE_SLOT_SH:-}" ] && [ -x "${GRADLE_SLOT_SH}" ]; then
        GRADLE_BIN="${GRADLE_BIN:-gradle}" "$GRADLE_SLOT_SH" "${a[@]}" "$@"
    else
        "${GRADLE_BIN:-gradle}" --no-daemon "${a[@]}" "$@"
    fi
}

_scanlist_print_env() {
    printf 'android-env: JAVA_HOME=%s\n' "${JAVA_HOME:-<unset>}"
    printf 'android-env: ANDROID_HOME=%s (aapt2=%s)\n' "${ANDROID_HOME:-<unset>}" "${ANDROID_AAPT2:-<none>}"
    printf 'android-env: NDK=%s\n' "${ANDROID_NDK_HOME:-<unset>}"
    printf 'android-env: GRADLE_USER_HOME=%s GRADLE_BIN=%s\n' "${GRADLE_USER_HOME:-<unset>}" "${GRADLE_BIN:-<unset>}"
}

_scanlist_android_env

# Sourced (bash: BASH_SOURCE != $0; zsh: ZSH_EVAL_CONTEXT contains ":file") = stay quiet.
_scanlist_sourced=0
if [ -n "${BASH_SOURCE:-}" ]; then
    [ "${BASH_SOURCE}" = "$0" ] || _scanlist_sourced=1
elif [ -n "${ZSH_EVAL_CONTEXT:-}" ]; then
    _scanlist_sourced=1
fi
if [ "$_scanlist_sourced" -eq 0 ]; then
    # Run directly (bash scripts/android-env.sh) just for a summary; exports do not survive.
    _scanlist_print_env
elif [ -n "${SCANLIST_ANDROID_ENV_VERBOSE:-}" ]; then
    _scanlist_print_env >&2
fi
unset _scanlist_sourced

unset -f _scanlist_path_add _scanlist_latest_dir _scanlist_print_env 2>/dev/null || true
