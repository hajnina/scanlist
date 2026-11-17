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
- Heartbeat: background `sleep 600 && echo HEARTBEAT-FIRE`, re-armed FIRST on every wakeup, then
  `bash scripts/lead-watchdog.sh`. The timer dies with the session — RE-ARM NOW after restart.

## IMMEDIATE FIRST ACTIONS after restart
1. `git status` — an aborted shell may have left `scripts/lead-watchdog.sh` edited-but-uncommitted
   (transient ls-remote flap handling). If so: `bash -n scripts/lead-watchdog.sh`, commit
   "lead: watchdog ls-remote transient flap handling", push.
2. Re-arm heartbeat: background shell `sleep 600 && echo HEARTBEAT-FIRE`.
3. Run `bash scripts/lead-watchdog.sh` and reconcile with the state below.

## Board state
- **31 of 34 cards done.** doing: A6, B7. todo: X2 (deps B7+A6), B0 (device-parked, parked with Martin).
- Kotlin main suite 296/0 · RN main 237 · web main 279 (29 files) · smoke 21/21 · ts-core 150 · server 130+1skip.
- Rolling release pipeline WORKS ("ScanList (rolling)" refreshes on code pushes; refs/tags/main stays 0 —
  the release job now self-cleans legacy tags unconditionally).
- CI runs real gates on every track (kotlin unit tests + summary, rn tsc+jest+APK, shared tsc+vitest, web).

## ACTIVE LANES (sessionIDs — message, don't redispatch)
| Lane | Session | State | Next action |
|---|---|---|---|
| **A6 fix round** (PR #36) | ses_e16c72cb8ffeB67tMx3QBcBi61 | Fix round pushed (modelMissing wiring + 1 s quiet interval + POLISH.md truth pass); rn CI run 44093111706 was pending; PR MERGEABLE | When CI green: message SAME reviewer **ses_e16678bb2ffeCnF8KCi9z8eOOu** to re-verify (its REQUEST-CHANGES verdict; reviewer≠builder). On APPROVE*: merge → `board.py move A6 done` → clean ../scanlist-wt/A6 + branch → fire A6-followup lane (below) + X2 check |
| **B7 review** (PR #39) | ses_e164fb78effevtDfmQt4FF1VX1 | Reviewing; CI kotlin pass 1m50s on 739a84c; conflict (card rename) already resolved by builder | On APPROVE*: merge → move B7 done → clean ../scanlist-wt/B7 → **X2 check**. On REQUEST-CHANGES: fix round to builder **ses_e166dcf0dffeTF3L7GY3H5VHKo**, same reviewer re-verifies |
| **C2-followup review** (PR #40) | ses_e164fb78affe1LxMG4LsnENN3H | Reviewing; web pass 42s; PR MERGEABLE | On APPROVE*: merge → NO card move → append evidence to done/C2.md → clean ../scanlist-wt/C2FU. On REQUEST-CHANGES: fix round to builder **ses_e165b4652ffesVWcEOI0tw72ZE** |
| **Heartbeat** | (background sleep) | DIED with restart | Re-arm (above) |

## QUEUED (dispatch on trigger)
- **X2** (COMPARISON.md, final content card) — fires when **B7 AND A6 are merged**. Fresh session, worktree
  `card/X2` off main. Evidence inputs pre-staged in lead-log entry "X2 dispatch checklist" (bench/results JSONs,
  PERF.md, bundle sizes web 211 kB / APK 291 MB vs 142 MB, agent-cost ~parity, image-latency asymmetry headline).
- **A6-followup** — fires when A6 merges: mount SettingsScreen (App.tsx disclosed wiring), startup application of
  the persisted backend choice, haptics setting read. Branch card/A6-followup + PR, evidence → done/A6.md.
- **B0** — parked (no phone on adb; aarch64 adb is x86_64 binary). Parked with Martin: model-license ruling,
  fleet timebox preference — resurface when board is otherwise clear.

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
