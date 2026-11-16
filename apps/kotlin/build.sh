#!/usr/bin/env bash
# ScanList Kotlin app — build entry point (card B1, "Done when": produce an APK).
#
#   apps/kotlin/build.sh                        # -> :scanlistKotlin:assembleDebug
#   apps/kotlin/build.sh :scanlistKotlin:tasks  # any Gradle task(s), same environment
#
# Builds from the REPO ROOT of the worktree, because the root settings.gradle.kts (card S9) owns
# the Gradle build and maps :scanlistKotlin -> apps/kotlin/app. Sourcing scripts/android-env.sh
# supplies the aarch64 laptop toolchain (JDK 17 + aarch64 aapt2 via GRADLE_OPTS / project
# property); on the x86_64 CI runner that script is a no-op and plain ./gradlew uses the Maven
# aapt2. No laptop path lives in any Gradle file.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# shellcheck source=../../scripts/android-env.sh
source scripts/android-env.sh

# Local builds sign with the thrown-away key; CI has no key and uses AGP's debug keystore.
bash apps/kotlin/app/scripts/make-debug-keystore.sh

tasks=("$@")
if [ "${#tasks[@]}" -eq 0 ]; then
    tasks=(":scanlistKotlin:assembleDebug")
fi

if declare -F scanlist_gradle >/dev/null 2>&1; then
    # Recommended laptop path: shared build-slot lock, --no-daemon, aarch64 aapt2 override.
    scanlist_gradle "${tasks[@]}"
else
    ./gradlew --no-daemon "${tasks[@]}"
fi
