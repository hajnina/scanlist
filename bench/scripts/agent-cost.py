#!/usr/bin/env python3
"""X1 — agent cost per track, from two independent sources.

This is the one metric that cannot be measured with a stopwatch, so it is built from evidence rather
than impressions:

  1. **opencode session ledger** (quantitative, read-only): `~/.local/share/opencode/opencode.db`,
     table `session_v2`, columns `tokens_input/output/reasoning/cache_read`, `cost`, `title`.
     ScanList sessions are created by the lead in the main checkout, so `directory` is always
     `/home/martin/projects/scanlist`; the *card* an agent worked on is in the session **title**
     ("Build card B3 in worktree", "Adversarial review of PR 19 (B3)"). We attribute by that card id.
     `cost` is 0.00 for the free tier (`deepseek-v4.1-flash-free`), so **output tokens** are the
     comparable unit of agent effort — they are what the model wrote, and they do not include the
     (heavily cached) re-reads of the repo.
  2. **kanban board + lead log** (qualitative): cards per track, merged PRs, REQUEST-CHANGES verdicts,
     `-sync` convergence rounds and infrastructure deaths, all counted from the committed markdown.

   python3 bench/scripts/agent-cost.py            # -> bench/results/fragments/agent-cost.json
   OPENCODE_DB=/path/to/opencode.db python3 ...   # if the ledger moved

Honest limits (repeated in the README and in the JSON):
  * tokens measure *agent output*, not human time; a track that needed more output did not
    necessarily take more wall-clock, and vice versa.
  * attribution is by regex on session titles; sessions with no card id ("Research …",
    "Premortem …", "Fresh re-review of PR 21 fix") go to an `unattributed` bucket. They are part of
    the project's cost, not of any one track.
  * the ledger only covers sessions this machine still has (see `coverage` below); treat the totals
    as a lower bound.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
REPO = BENCH.parent
KANBAN = REPO / "kanban"
DB = Path(os.environ.get("OPENCODE_DB", Path.home() / ".local/share/opencode/opencode.db"))

# A/B/C = the three app tracks, S = shared foundation, X = comparison/lead work.
TRACK_OF = {"A": "rn", "B": "kotlin", "C": "web", "S": "shared", "X": "compare"}
CARD_RE = re.compile(r"\b([ABCSX])(\d+)(-sync)?\b")
PR_CARD_RE = re.compile(r"PR #\d+ \(([ABCSX]\d+)(?:-sync)?\)")


def track_of(card: str) -> str:
    return TRACK_OF.get(card[0].upper(), "other")


def card_of_title(title: str) -> str | None:
    """First card id in the session title — 'Build card B3 in worktree' -> B3."""
    match = CARD_RE.search(title or "")
    if not match:
        return None
    return f"{match.group(1)}{match.group(2)}"


def read_sessions() -> dict:
    if not DB.is_file():
        return {"status": "n/a", "reason": f"opencode ledger not found at {DB}"}
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        rows = list(
            conn.execute(
                "select title, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, "
                "tokens_cache_write, cost, time_created from session_v2 "
                "where directory like '%scanlist%' order by time_created"
            )
        )
    except sqlite3.Error as err:  # schema drift is a reason, not a crash
        return {"status": "n/a", "reason": f"opencode ledger unreadable: {err}"}
    finally:
        conn.close()

    per_track: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "tokensOutput": 0, "tokensInput": 0, "cacheRead": 0, "cost": 0.0, "cards": set()}
    )
    for title, tok_in, tok_out, tok_reason, cache_read, cache_write, cost, _ts in rows:
        card = card_of_title(title)
        bucket = per_track[track_of(card) if card else "unattributed"]
        bucket["sessions"] += 1
        bucket["tokensOutput"] += tok_out or 0
        bucket["tokensInput"] += tok_in or 0
        bucket["cacheRead"] += cache_read or 0
        bucket["cost"] += cost or 0.0
        if card:
            bucket["cards"].add(card)

    out = {}
    for track, v in per_track.items():
        out[track] = {**v, "cards": sorted(v["cards"])}
    stamps = [r[7] for r in rows if r[7]]
    return {
        "status": "measured",
        "source": str(DB),
        "coverage": {
            "sessions": len(rows),
            "from": datetime.fromtimestamp(min(stamps) / 1000, timezone.utc).isoformat() if stamps else None,
            "to": datetime.fromtimestamp(max(stamps) / 1000, timezone.utc).isoformat() if stamps else None,
        },
        "tracks": out,
        "unit": "tokens_output is the comparable unit (free tier => cost 0.00)",
    }


def read_kanban() -> dict:
    cards = defaultdict(list)
    for state in ("done", "doing", "todo"):
        directory = KANBAN / state
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            card = path.stem
            cards[track_of(card)].append(
                {"id": card, "state": state, "sync": card.endswith("-sync"), "path": f"kanban/{state}/{card}.md"}
            )
    return cards


def read_lead_log() -> dict:
    path = KANBAN / "lead-log.md"
    if not path.is_file():
        return {"status": "n/a", "reason": "kanban/lead-log.md missing"}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    merged = defaultdict(int)
    request_changes = defaultdict(int)
    deaths = defaultdict(int)
    death_lines = []
    for i, line in enumerate(lines):
        for card in PR_CARD_RE.findall(line):
            if "merged" in line:
                merged[track_of(card)] += 1
        if "REQUEST-CHANGES" in line:
            cards = [f"{m[0]}{m[1]}" for m in CARD_RE.findall(line)]
            # The verdict often names the card one line above the detail; check the neighbourhood.
            if not cards and i > 0:
                cards = [f"{m[0]}{m[1]}" for m in CARD_RE.findall(lines[i - 1])]
            for card in cards or ["?"]:
                request_changes[track_of(card) if card != "?" else "unattributed"] += 1
        if re.search(r"\bdied\b|\bkilled\b|ECONNRESET|OUTAGE|outage", line):
            death_lines.append(line.strip()[:180])
            cards = [f"{m[0]}{m[1]}" for m in CARD_RE.findall(line)]
            for card in cards or ["fleet"]:
                deaths[track_of(card) if card != "fleet" else "fleet-wide"] += 1
    return {
        "status": "measured",
        "mergedPrs": dict(merged),
        "requestChangesVerdicts": dict(request_changes),
        "infraDeaths": dict(deaths),
        "infraDeathLines": death_lines,
    }


def main() -> None:
    sessions = read_sessions()
    cards = read_kanban()
    lead = read_lead_log()

    card_counts = {
        track: {
            "total": len(entries),
            "done": sum(1 for c in entries if c["state"] == "done"),
            "doing": sum(1 for c in entries if c["state"] == "doing"),
            "todo": sum(1 for c in entries if c["state"] == "todo"),
            "syncRounds": sum(1 for c in entries if c["sync"]),
            "ids": [c["id"] for c in entries],
        }
        for track, entries in cards.items()
    }

    # Normalised cost: output tokens per merged card, when both numbers exist.
    ratios = {}
    if sessions.get("status") == "measured":
        for track, v in sessions["tracks"].items():
            merged = (lead.get("mergedPrs") or {}).get(track, 0)
            if merged and v["tokensOutput"]:
                ratios[track] = {
                    "tokensOutputPerMergedPr": round(v["tokensOutput"] / merged),
                    "mergedPrs": merged,
                }

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "method": "bench/scripts/agent-cost.py — opencode session ledger (tokens/cost, attributed by card id in the session title) "
        "+ committed kanban/lead-log evidence (merged PRs, REQUEST-CHANGES verdicts, sync rounds, infra deaths).",
        "honestLimits": [
            "tokens measure agent output, not human wall-clock; cost 0.00 on the free tier makes tokens the only comparable unit",
            "sessions without a card id in the title are reported as `unattributed` — project-wide cost, not one track's",
            "the ledger is a lower bound: it only holds sessions this machine still has (see sessions.coverage)",
            "lead-log counts are regex over prose; the log is the evidence, the numbers are an index into it",
        ],
        "sessions": sessions,
        "cards": card_counts,
        "leadLog": lead,
        "normalised": ratios,
    }
    frag = BENCH / "results" / "fragments"
    frag.mkdir(parents=True, exist_ok=True)
    (frag / "agent-cost.json").write_text(json.dumps(payload, indent=2) + "\n")

    print(f"{'track':<14}{'sessions':>9}{'outTokens':>11}{'cacheRead':>12}{'cards':>7}{'merged':>7}{'reqChg':>7}")
    tracks = sorted(set(card_counts) | set((sessions.get("tracks") or {})))
    for track in tracks:
        s = (sessions.get("tracks") or {}).get(track, {})
        c = card_counts.get(track, {})
        print(
            f"{track:<14}{s.get('sessions', 0):>9}{s.get('tokensOutput', 0):>11}"
            f"{s.get('cacheRead', 0):>12}{c.get('total', 0):>7}"
            f"{(lead.get('mergedPrs') or {}).get(track, 0):>7}"
            f"{(lead.get('requestChangesVerdicts') or {}).get(track, 0):>7}"
        )
    print("-> bench/results/fragments/agent-cost.json")


if __name__ == "__main__":
    sys.exit(main())
