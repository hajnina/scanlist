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
unzip -l "$APK" | grep -q 'assets/index.android.bundle' || {
  echo "::error::emulator APK has no JS bundle — it would need Metro"; exit 1; }

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.CAMERA || true
adb logcat -c
adb shell am start -W -n "$ACTIVITY" | tee launch.txt
grep -q "Status: ok" launch.txt

# Cold start of a release RN app: give the first frame time, then require a live process.
sleep 15
pid="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$pid" || { echo "::error::app process not running after launch"; exit 1; }
adb exec-out screencap -p > screen-1-lists.png

if adb logcat -d | grep -q "FATAL EXCEPTION"; then
  echo "::error::app crashed on launch"
  adb logcat -d | tail -150
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

if adb logcat -d | grep -q "FATAL EXCEPTION"; then
  echo "::error::app crashed during navigation"
  adb logcat -d | tail -150
  exit 1
fi

echo "SMOKE PASS: pid=$pid"
