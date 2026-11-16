#!/usr/bin/env bash
# ScanList Kotlin app — throwaway debug signing key (card B1).
#
# Adapted from references/bonsai-ui/src/bonsai-serve/scripts/make-debug-keystore.sh: generate a
# local key instead of copying one, and write it to a gitignored path. app/.signing/debug.jks is
# ignored by app/.gitignore (and by the repo root's `*.jks`), so no keystore ever enters git;
# app/build.gradle.kts only uses it when it exists and otherwise falls back to AGP's debug key.
#
# Usage: scripts/make-debug-keystore.sh          (build.sh calls this automatically)
#        SCANLIST_KEYSTORE=/tmp/x.jks scripts/make-debug-keystore.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${SCANLIST_KEYSTORE:-$here/.signing/debug.jks}"

if [ -f "$out" ]; then
    echo "keystore: $out already exists (throwaway debug key, gitignored)"
    exit 0
fi

# keytool comes from the JDK used for the build (scripts/android-env.sh exports JAVA_HOME).
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
    keytool_bin="$JAVA_HOME/bin/keytool"
else
    keytool_bin="${KEYTOOL:-keytool}"
fi

mkdir -p "$(dirname "$out")"
"$keytool_bin" -genkeypair \
    -keystore "$out" \
    -storetype PKCS12 \
    -alias scanlist \
    -storepass android \
    -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=ScanList Kotlin debug, O=dev.hajnina, C=CH"
chmod 600 "$out"
echo "keystore: wrote throwaway debug key $out (gitignored, never committed)"
