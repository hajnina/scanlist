#!/usr/bin/env bash
# ScanList — generate the throwaway Android *debug* keystore (card A1).
#
# Hard rule (AGENTS.md): keystores never go into git. React Native's Gradle template signs the
# debug (and, for this comparison app, the release) build with `android/app/debug.keystore`, so
# instead of committing one we generate the standard Android debug identity on demand. Both the
# laptop build (`apps/rn/build.sh`) and a bare `./gradlew assembleDebug` (CI) call this script,
# and it is idempotent: an existing keystore is left untouched.
#
# Credentials are the public Android debug ones (alias androiddebugkey / password android) —
# nothing secret, nothing reusable for a real release.
#
# Usage: scripts/make-debug-keystore.sh [output-path]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/../android/app/debug.keystore}"

if [ -s "$out" ]; then
    echo "make-debug-keystore: $out exists — leaving it alone"
    exit 0
fi

if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
    keytool="$JAVA_HOME/bin/keytool"
elif command -v keytool >/dev/null 2>&1; then
    keytool="$(command -v keytool)"
else
    echo "make-debug-keystore: no keytool (set JAVA_HOME to a JDK 17 or newer)" >&2
    exit 1
fi

mkdir -p "$(dirname "$out")"
"$keytool" -genkeypair -v \
    -keystore "$out" \
    -storetype PKCS12 \
    -storepass android -keypass android \
    -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=ScanList Debug,O=ScanList,C=US" \
    >/dev/null

echo "make-debug-keystore: generated throwaway debug keystore $out (alias androiddebugkey)"
