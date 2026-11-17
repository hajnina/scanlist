# LEAD HANDOFF — read this first after restart (2026-11-17, written mid-flight)

You are the ScanList project lead. Your job: dispatch builders per kanban card, run adversarial reviews,
merge on APPROVE / APPROVE-WITH-NITS, close out, log. NEVER do content work inline — even micro-fixes go to
delegate agents. Full rules in AGENTS.md; running decision log in kanban/lead-log.md (read the last ~10 entries).

## Standing rules (hard-won, do not re-learn)
- NEVER use `main:main` refspecs (recreates shadow tag `main`). Plain `git fetch origin main` / `git pull --no-rebase`.
- A closeout is NOT a closeout until `gh pr view <n> --json mergedAt` shows a timestamp (PR #34 incident).
- Restart dead subagents IN-SESSION by messaging their sessionID (free-limit waves hit 5 at once twice today;
  all recovered). If a session is unreachable, re-dispatch fresh — all briefs are in the lead-log.
- Sync/followup rounds: own branch `card/<ID>-<suffix>` + PR, NO card moves, NO kanban edits; evidence appended
  to the PARENT done card after merge. Builders stop after PR open; same reviewer re-verifies when reviewer≠builder.
- Create the worktree AFTER `board.py claim` (B7's todo→doing rename conflict lesson).
- Never merge your own PRs; never edit `.github/` except via lead-authorized delegate (direct-to-main precedent).
- **SESSION PARENTAGE DIES WITH A RESTART**: subagent IDs from a previous lead session are NOT messageable ("not a child of
  the current session"). After a restart, re-dispatch fresh sessions and carry the prior findings in the brief — do not
  burn cycles trying to resume.
- Heartbeat: background `sleep 600 && echo HEARTBEAT-FIRE`, re-armed FIRST on every wakeup, then
  `bash scripts/lead-watchdog.sh`. The timer dies with the session — RE-ARM NOW after restart.

## IMMEDIATE FIRST ACTIONS after restart
1. `git status` — an aborted shell may have left `scripts/lead-watchdog.sh` edited-but-uncommitted
   (transient ls-remote flap handling). If so: `bash -n scripts/lead-watchdog.sh`, commit
   "lead: watchdog ls-remote transient flap handling", push.
2. Re-arm heartbeat: background shell `sleep 600 && echo HEARTBEAT-FIRE`.
3. Run `bash scripts/lead-watchdog.sh` and reconcile with the state below.

## Board state (FINAL, 2026-11-17 15:15Z)
- **33 of 34 cards done.** doing: none. review: none. **todo: B0 only** (device-parked with Martin).
- Merged this session: C2-followup (#40, 13:49:35Z), B7 (#39, 14:40:36Z), A6 (#36, 14:52:08Z), X2 (#41, 15:13:09Z) — all `mergedAt`-verified.
- Main suites: Kotlin 329 · RN 352 · web 291 · ts-core 150 · server 130+1 skip · smoke 21/21.
- Rolling release healthy; `refs/tags/main` = 0; no closed-unmerged PRs.


## ACTIVE LANES
**None.** Every lane is closed and its worktree/branch is deleted (A6, B7, C2FU, X2 all removed).


## QUEUED (nothing is dispatched)
- **B0** — still parked with Martin: needs a phone on adb (aarch64 adb is an x86_64 binary), plus his model-license ruling and fleet-timebox preference.
- **A6-followup** (not a card; deferred by the 2026-11-17 deadline): mount `SettingsScreen` from `App.tsx`, apply the persisted backend choice at startup, read the haptics setting. Evidence would go to `done/A6.md`.
- **Recorded-only nits** (do NOT dispatch without a reason): 6 C2-followup sweep nits on `done/C2.md`; B7 N5/N8/N9 on `done/B7.md`; A6's hero-reset-only mutation caveat on `done/A6.md`.


## Merge protocol (verbatim)
`gh pr merge <n> --merge` → `git pull --no-rebase` → `gh pr view <n> --json mergedAt` (VERIFY) →
`python3 kanban/board.py move <ID> done` (board.py commits; a chained manual commit no-ops) → push →
`git worktree remove --force ../scanlist-wt/<ID>` + `git branch -d card/<ID>` + `git push origin --delete card/<ID>`
→ rm reviewer /tmp/opencode clones → append evidence to the done card → lead-log entry → push.
Sync rounds: no card move; evidence on parent done card.

## Watchdog script notes
- `scripts/lead-watchdog.sh`: open PRs + CI, card/* tip diff (transient ls-remote flap → "TRANSIENT" line,
  tips preserved), closed-unmerged audit (#34 PERMANENTLY waived — superseded by re-land #37, merged;
  any NEW closed-unmerged alarms), refs/tags/main count, release list, main.yml runs.
- Tips state file: /tmp/opencode/watchdog-tips.txt.

## Recent history (one line each — full detail in lead-log)
- PR #37 merged = C5 re-land COMPLETE (PR #34 was never merged — lead closeout error, incident closed, watchdog
  audit added). C5 nits N1/N2 closed (840b0ca). A5-OFF-sync merged (PR #38, OFF semantics port, 237 tests).
- B5 merged (PR #33) after lane-starvation fix (296/0). C7 merged (PR #35): spike verdict = embeddings stay
  server-side (fp16 works but 543-878 MB + WebGPU gate; images unproven; C4 uploader = future flip point).
- CI incident closed: release job tolerates empty rel/, legacy cleanup unconditional; rolling tag renamed;
  forensics = old-workflow run still executing when rename landed.
