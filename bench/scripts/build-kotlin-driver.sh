#!/usr/bin/env bash
# X1 — build + run the Kotlin-track rank driver (bench/driver/Rank200.java).
#
# The driver links against the Kotlin app's ALREADY-BUILT classes, so it never edits or rebuilds
# apps/kotlin: it just needs the debug classes to exist. Two prerequisites, both documented in the
# README:
#
#   1. source scripts/android-env.sh && ./gradlew :scanlistKotlin:assembleDebug
#      (produces apps/kotlin/app/build/tmp/kotlin-classes/debug)
#   2. node bench/scripts/make-fixture.mjs
#      (produces bench/.cache/rank200.txt)
#
# Kotlin top-level functions compile to `RankKt` static methods, so javac + kotlin-stdlib is enough:
# no kotlinc, no Gradle change, nothing written outside bench/.
set -euo pipefail

BENCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$BENCH/.." && pwd)"
CLASSES="$REPO/apps/kotlin/app/build/tmp/kotlin-classes/debug"
OUT="$BENCH/.cache/driver"
TOOLCHAIN="${ANDROID_TOOLCHAIN:-$HOME/projects/martins-whisper/android-toolchain}"

if [ ! -d "$CLASSES" ]; then
  echo "missing $CLASSES" >&2
  echo "build it first: source scripts/android-env.sh && ./gradlew :scanlistKotlin:assembleDebug" >&2
  exit 2
fi

# JDK: the aarch64 Android toolchain's (Temurin 17), else whatever java/javac are on PATH.
if [ -x "$TOOLCHAIN/jdk/bin/javac" ]; then
  JAVAC="$TOOLCHAIN/jdk/bin/javac"
  JAVA="$TOOLCHAIN/jdk/bin/java"
else
  JAVAC="$(command -v javac)"
  JAVA="$(command -v java)"
fi

# kotlin-stdlib: the version the project's Kotlin plugin pins, from the shared Gradle home.
STDLIB="${KOTLIN_STDLIB:-}"
if [ -z "$STDLIB" ]; then
  STDLIB="$(find "$TOOLCHAIN/gradle-home" -name 'kotlin-stdlib-2.0.21.jar' 2>/dev/null | head -1 || true)"
fi
if [ -z "$STDLIB" ] || [ ! -f "$STDLIB" ]; then
  STDLIB="$(find "$TOOLCHAIN/gradle-home" -name 'kotlin-stdlib-2.*.jar' -path '*modules-2*' 2>/dev/null | sort | tail -1 || true)"
fi
if [ -z "$STDLIB" ] || [ ! -f "$STDLIB" ]; then
  echo "kotlin-stdlib jar not found under $TOOLCHAIN/gradle-home — set KOTLIN_STDLIB=/path/to/kotlin-stdlib.jar" >&2
  exit 2
fi

mkdir -p "$OUT"
"$JAVAC" -nowarn -cp "$CLASSES:$STDLIB" -d "$OUT" "$BENCH/driver/Rank200.java"
echo "kotlin-stdlib: $STDLIB"
"$JAVA" -cp "$OUT:$CLASSES:$STDLIB" Rank200 "$BENCH/.cache/rank200.txt" "$BENCH/results/fragments/rank-kotlin.json"
