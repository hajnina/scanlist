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

## Board state (ls-verified 2026-11-17 13:40Z — the old "31" tally was WRONG by one)
- **30 of 34 cards done.** doing: A6, B7, **X2 (pre-fired, building — will show as doing once claimed)**. todo: B0 (device-parked, parked with Martin).
- Kotlin main suite 296/0 · RN main 237 · web main 279 (29 files) · smoke 21/21 · ts-core 150 · server 130+1skip.
- Rolling release pipeline WORKS ("ScanList (rolling)" refreshes on code pushes; refs/tags/main stays 0 —
  the release job now self-cleans legacy tags unconditionally).
- CI runs real gates on every track (kotlin unit tests + summary, rn tsc+jest+APK, shared tsc+vitest, web).

## ACTIVE LANES (sessionIDs — these are POST-RESTART sessions, children of the current lead)
| Lane | Session | State | Next action |
|---|---|---|---|
| **A6 re-review** (PR #36) | ses_e1644f1ceffeX6geWskfWSGy7J | Fresh adversarial reviewer (old session orphaned); head 3d6c68f; rn CI in_progress | On APPROVE*: merge (#36) → `gh pr view --json mergedAt` → `board.py move A6 done` → clean ../scanlist-wt/A6 + branch → **dispatch A6-followup** → fire X2 check |
| **B7 review** (PR #39) | ses_e1644f1cdffef0SfOFkbX0bnEs | Fresh reviewer; kotlin pass on 739a84c; MERGEABLE/CLEAN | On APPROVE*: merge → verify mergedAt → move B7 done → clean ../scanlist-wt/B7 → X2 check |
| **C2-followup review** (PR #40) | ses_e1644f1c6ffeRKiFvbtX1wbHlb | Fresh reviewer; web pass on 2bc52ef; MERGEABLE/CLEAN | On APPROVE*: merge → NO card move → evidence to done/C2.md → clean ../scanlist-wt/C2FU |
| **X2 builder** (bench/COMPARISON.md) | ses_e1644f1c4ffe15SZAnuhPFy9xt | Pre-fired in parallel; claims X2 then worktree card/X2; must refresh numbers vs origin/main before PR-open | On PR open: dispatch fresh reviewer; on APPROVE*: merge → move X2 done → clean worktree/branch |
| **Heartbeat** | (background sleep, armed 13:34Z) | ALIVE | Re-arm on every fire; run scripts/lead-watchdog.sh |

## QUEUED (dispatch on trigger)
- **X2** (COMPARISON.md, final content card) — **IN FLIGHT** (pre-fired 13:40Z, session ses_e1644f1c4ffe15SZAnuhPFy9xt). Deps B7+A6 are landing in parallel; brief forbids citing them as merged and requires a number refresh vs origin/main before PR-open. Evidence inputs: bench/results/*.json + fragments, bench/README.md, apps/web/server/PERF.md, done cards X1/C4/C5/C7/A5/B5/B6, lead-log "X2 dispatch checklist" (bundle sizes web ~211 kB / APK 291 MB vs 142 MB, agent-cost ~parity, image-latency asymmetry headline).
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
