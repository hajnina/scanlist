#!/usr/bin/env bash
# lead-watchdog.sh — one-shot lane-health snapshot for the ScanList lead heartbeat.
# The lead runs this on every heartbeat wakeup (~10 min) and acts on findings:
#   RED PR            -> gh run view --log-failed, route the fix to that lane's session
#   stalled lane      -> card/* tip unchanged >=2 cycles with no PR open -> nudge its session
#   tag plague        -> refs/tags/main > 0 or "ScanList (main)" releases -> CI incident unfixed
#   quiet fleet       -> no open PRs + ready cards -> dispatch the next card
set -u
cd "$(dirname "$0")/.." || exit 1

echo "== open PRs =="
gh pr list --state open --json number,title,headRefName,mergeable \
  --jq '.[] | "#\(.number) [\(.headRefName)] mergeable=\(.mergeable) \(.title)"' 2>/dev/null
for n in $(gh pr list --state open --json number --jq '.[].number' 2>/dev/null); do
  echo "-- checks #$n:"
  gh pr checks "$n" 2>/dev/null | sed 's/^/   /'
done

echo "== lane branch tips (card/*) =="
TIPS=/tmp/opencode/watchdog-tips.txt
NEW=$(mktemp)
git ls-remote --heads origin 'card/*' | sort >"$NEW" 2>/dev/null
if [ -s "$NEW" ]; then
  if [ -f "$TIPS" ]; then
    CHANGED=$(comm -13 "$TIPS" "$NEW")
    if [ -n "$CHANGED" ]; then
      echo "CHANGED since last heartbeat:"
      echo "$CHANGED"
    else
      echo "(no new pushes since last heartbeat)"
    fi
  else
    echo "first snapshot:"
    cat "$NEW"
  fi
  cp "$NEW" "$TIPS"
else
  echo "(no card/* branches on origin)"
fi
rm -f "$NEW"

echo "== closed-unmerged audit (lead incident lesson: a closeout isn't a closeout until mergedAt != null) =="
# WAIVED: #34 closed-unmerged — superseded AND completed by re-land PR #37 (MERGED 13:13:41Z, mergedAt-verified).
# The waiver is permanent: #34 can never merge; any NEW closed-unmerged PR still alarms.
gh pr list --state closed --limit 10 --json number,mergedAt \
  --jq '.[] | select(.mergedAt == null and .number != 34) | "ALARM: #\(.number) CLOSED-UNMERGED"' 2>/dev/null || true

echo "== tag plague + release job =="
echo "refs/tags/main count: $(git ls-remote --tags origin 'refs/tags/main' | wc -l) (0 = clean)"
gh release list --limit 5 2>/dev/null | sed 's/^/   /'
gh run list --workflow main.yml --limit 3 2>/dev/null | sed 's/^/   /'
