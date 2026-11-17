#!/usr/bin/env bash
# X1 — run every benchmark top-to-bottom and rebuild bench/results/*.json.
#
#   bash bench/scripts/run-all.sh                 # everything that is possible on this checkout
#   bash bench/scripts/run-all.sh --quick         # skip the gradle build/tests (keeps rank + sizes + web)
#
# Each step is independent and degrades to `n/a` with a reason instead of failing the run, so this is
# safe on a partial checkout (no phone, no torch venv, no node_modules). Read bench/README.md first;
# it says what each script needs and why some numbers cannot exist here.
#
# Prerequisites that this script does NOT install (all gitignored, see README):
#   bench/node_modules               (cd bench && npm install)
#   bench/.venv                      (python3 -m venv bench/.venv && bench/.venv/bin/pip install numpy)
#   apps/web/frontend/node_modules   (cd apps/web/frontend && npm install)
#   apps/rn/node_modules             (cd apps/rn && npm ci)        # optional: metro/jest timings
#   Android toolchain               (scripts/android-env.sh)        # optional: kotlin APK + classes
set -uo pipefail

BENCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$BENCH/.." && pwd)"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

step() { printf '\n=== %s\n' "$*"; }
soft() { "$@" || printf '    (step failed — the results file keeps an n/a for it)\n'; }

step "1/9 fixture (200 items, 256-d, 16 text + 1 image query)"
soft node "$BENCH/scripts/make-fixture.mjs"

step "2/9 rank — shared ts-core (node)"
soft node "$BENCH/scripts/rank-ts-core.mjs"

step "3/9 rank — python oracle"
if [ -x "$BENCH/.venv/bin/python" ]; then
  soft "$BENCH/.venv/bin/python" "$BENCH/scripts/rank-oracle.py"
else
  printf '    no bench/.venv — python3 -m venv bench/.venv && bench/.venv/bin/pip install numpy\n'
fi

step "4/9 rank — Kotlin (JVM driver over the app's compiled classes)"
if [ ! -d "$REPO/apps/kotlin/app/build/tmp/kotlin-classes/debug" ]; then
  if [ "$QUICK" = "0" ]; then
    printf '    classes missing, building them: ./gradlew :scanlistKotlin:assembleDebug\n'
    soft bash -c "cd '$REPO' && source scripts/android-env.sh && ./gradlew :scanlistKotlin:assembleDebug --console=plain >/dev/null"
  fi
fi
soft bash "$BENCH/scripts/build-kotlin-driver.sh"

step "5/9 web cold start (real Chrome, fresh profile per run)"
soft node "$BENCH/scripts/coldstart-web.mjs"

step "6/9 sizes (APKs, RN bundle, web dist)"
soft env \
  X1_KOTLIN_CI_APK="${X1_KOTLIN_CI_APK:-}" \
  X1_RN_APK="${X1_RN_APK:-}" \
  X1_RN_BUNDLE="${X1_RN_BUNDLE:-}" \
  node "$BENCH/scripts/sizes.mjs"

step "7/9 build times"
if [ "$QUICK" = "1" ]; then
  soft node "$BENCH/scripts/buildtimes.mjs" --skip-gradle
else
  soft node "$BENCH/scripts/buildtimes.mjs" --ci
fi

step "8/9 lines of code + agent cost"
soft python3 "$BENCH/scripts/loc.py"
soft python3 "$BENCH/scripts/agent-cost.py"

step "9/9 assemble bench/results/<track>.json"
soft node "$BENCH/scripts/assemble.mjs"

printf '\nDone. Results: bench/results/{kotlin,rn,web,oracle}.json (fragments in bench/results/fragments/).\n'
