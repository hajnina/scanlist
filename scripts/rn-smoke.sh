#!/usr/bin/env bash
# Install, launch and screenshot the RN app on a running emulator.
#
# Used by .github/workflows/{pr,main}.yml (rn-smoke job) via
# `reactivecircus/android-emulator-runner`. The action executes its `script` input line by line in
# separate shells, so variables/functions here MUST live in a file: a multi-line inline script
# loses `$apk` between lines ("adb: filename doesn't end .apk") — the exact failure of run
# 44165429492.
#
# Requirements: adb on PATH, an emulator booted, and a release APK already built at $APK.
# The APK is the x86_64 variant in CI (the shipped arm64 APK cannot install on the x86_64 runner);
# everything except the ABI is the shipping configuration.
set -euo pipefail

APK="${APK:-apps/rn/android/app/build/outputs/apk/release/app-release.apk}"
PKG="dev.hajnina.scanlist.rn"
ACTIVITY="$PKG/.MainActivity"

test -f "$APK" || { echo "::error::APK not found: $APK"; exit 1; }

# The shipping gate lives in the workflow (bundle present, arm64 only). Here we only prove LOAD,
# but re-assert the bundle on the emulator APK too: the x86_64 variant must also be standalone.
#
# The listing goes to a file on purpose. `unzip -l "$APK" | grep -q ...` under `set -o pipefail`
# FAILS even when the bundle is present: grep -q exits at the first match, unzip dies of SIGPIPE
# (141), and pipefail propagates 141. That false negative failed run 44168106312 after a green
# build ("emulator APK has no JS bundle" while :app:createBundleReleaseJsAndAssets had just run).
apk_list="$(mktemp)"
unzip -l "$APK" > "$apk_list"
grep -q 'assets/index.android.bundle' "$apk_list" || {
  echo "::error::emulator APK has no JS bundle — it would need Metro"; exit 1; }
bundle_bytes="$(awk '/assets\/index.android.bundle/{print $1}' "$apk_list")"
abis="$(grep -oE 'lib/[^/]+/' "$apk_list" | cut -d/ -f2 | sort -u | paste -sd, -)"
echo "emulator APK: $(stat -c%s "$APK") bytes, JS bundle ${bundle_bytes} bytes, ABIs: ${abis:-none}"

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.CAMERA || true
adb logcat -c
adb shell am start -W -n "$ACTIVITY" | tee launch.txt
grep -q "Status: ok" launch.txt

# Cold start of a release RN app: give the first frame time, then require a live process.
sleep 15
pid="$(adb shell pidof "$PKG" | tr -d '\r' || true)"
test -n "$pid" || { echo "::error::app process not running after launch"; exit 1; }
adb exec-out screencap -p > screen-1-lists.png

# Same pipefail/SIGPIPE trap as the bundle guard above: capture the log, then grep the file.
adb logcat -d > logcat-launch.txt
if grep -q "FATAL EXCEPTION" logcat-launch.txt; then
  echo "::error::app crashed on launch"
  tail -150 logcat-launch.txt
  exit 1
fi

# Best-effort navigation by visible/accessibility label. Returns 1 when not found (caller ignores).
tap_text() {
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || return 1
  adb pull /sdcard/window.xml . >/dev/null 2>&1 || return 1
  python3 - "$1" <<'PY'
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

needle = sys.argv[1].lower()
root = ET.parse('window.xml').getroot()
for node in root.iter('node'):
    label = ((node.get('text') or '') + ' ' + (node.get('content-desc') or '')).strip()
    if needle in label.lower():
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
        subprocess.run(
            ['adb', 'shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)],
            check=True,
        )
        print('tapped:', label)
        sys.exit(0)
sys.exit(1)
PY
}

if tap_text "Settings"; then
  sleep 3
  adb exec-out screencap -p > screen-2-settings.png
  adb shell input keyevent 4
  sleep 3
fi

if tap_text "Magic scan"; then
  sleep 4
  adb exec-out screencap -p > screen-3-scan.png
  adb shell input keyevent 4
  sleep 2
fi

adb logcat -d > logcat-end.txt
if grep -q "FATAL EXCEPTION" logcat-end.txt; then
  echo "::error::app crashed during navigation"
  tail -150 logcat-end.txt
  exit 1
fi

echo "SMOKE PASS: pid=$pid"
