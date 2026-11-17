# LEAD HANDOFF — read this first after restart (2026-11-17, post-X2 refresh)

You are the ScanList project lead. Your job: dispatch builders per kanban card, run adversarial reviews,
merge on APPROVE / APPROVE-WITH-NITS, close out, log. NEVER do content work inline — even micro-fixes go to
delegate agents. Full rules in AGENTS.md; running decision log in kanban/lead-log.md (read the last ~10 entries;
newest are anchor-inserted near the TOP, use grep for headings).

## Standing rules (hard-won, do not re-learn)
- NEVER use `main:main` refspecs (recreates shadow tag `main`). Plain `git fetch origin main` / `git pull --no-rebase`.
- A closeout is NOT a closeout until `gh pr view <n> --json mergedAt` shows a timestamp (PR #34 incident).
- SESSION PARENTAGE DIES WITH A RESTART: subagent IDs from a previous lead session are NOT messageable.
  After a restart, re-dispatch fresh and carry prior findings in the brief.
- PARALLEL LEADS are legitimate (this project ran two coordinating instances). Division-of-labor rule:
  the instance whose CHILD a reviewer/builder session is holds the verdict notification and executes that PR's
  merge + closeout + next-dispatch chain. Others reconcile read-only. Takeover only on an observed stall
  (≥2 dead cycles, no lane movement + no other-lead log entries), ANNOUNCED in the log before acting.
- Sync/followup rounds: own branch `card/<ID>-<suffix>` + PR, NO card moves, NO kanban edits; evidence appended
  to the PARENT done card after merge. Builders stop after PR open; same reviewer re-verifies when reviewer≠builder.
- Reviewer-prescribed exact fixes may merge WITHOUT a third round (B5/B7 precedent) if CI is green on the head.
- Create the worktree AFTER `board.py claim` (B7's todo→doing rename conflict lesson — it bit twice: B7 AND X2).
- Heartbeat: background `sleep 600 && echo HEARTBEAT-FIRE`, re-arm FIRST on every wakeup, then
  `bash scripts/lead-watchdog.sh`. Watchdog gh probes already have `timeout 60` (transient-hang hardening).
- Disk quota: /tmp is a 16 GB tmpfs that hit EDQUOT twice — reviewers should clone into /dev/shm when tight.
- ALWAYS `source scripts/android-env.sh` before gradle; `--tests` filter broken locally (run full suite for mutations).
- `gh pr edit` is BROKEN on this gh version (projects-classic GraphQL deprecation) — update PR bodies via REST:
  `gh api repos/hajnina/scanlist/pulls/<n> -X PATCH -f body="$(cat body.md)"`.
- Martin merges his own lanes WITHOUT reviews sometimes (mergedBy hajnina, #42/#43) — accepted; adversarial
  review then runs POST-merge and REQUEST-CHANGES becomes a fix-PR on main (that's how #42's inert ABI cut was caught).

## Board state (2026-11-17 ~17:10Z)
- **33 of 34 done.** doing: empty · review: empty · todo: **B0** (device-parked WITH MARTIN: no phone on adb —
  aarch64 laptop vs x86_64 adb binary; plus model-license ruling + fleet timebox preference).
- X2 MERGED (PR #41, 15:13:09Z): `bench/COMPARISON.md` — verdict **Kotlin**, provisional on B0; strongest
  counter-argument **web, not RN**. Builder self-check 150 number assertions; reviewer re-ran 150/150.
- HARDENING TAIL beyond the board: A6-followup merged (PR #44, 16:56:00Z, APPROVE on aaaa4b0) · apk-size merged
  (PR #45, 16:39:55Z, arm64-only verified from the CI artifact: 113.5 MiB, arm64-v8a ONLY — retro card
  kanban/done/apk-size.md) · model-download-fix = **PR #46 open, re-verify in flight**.
- Suites on main: Kotlin 39 classes / 329 · RN **33 suites / 381** (post-#44) · web 29 files / 291 · smoke 21/21 ·
  ts-core 150 · server 130+1skip.

## ACTIVE LANES
| Lane | Session | State | Next action |
|---|---|---|---|
| **#46 model-download-fix re-verify** (lead-A child) | ses_e15b99e8affeea5X6HbcOuRY6r | Reviewer re-verifying the 6-item fix list (head 7493c25, rn CI pass 5m26s, MERGEABLE) | On APPROVE*: `gh pr merge 46 --merge` → pull → VERIFY mergedAt → retro card `kanban/done/model-download.md` (lane never had a card; reconstruct from PR bodies + review evidence incl. the pre-verdict-merge note) → clean `../scanlist-wt/MODELDL` + branch `card/model-download-fix` → lead-log → push. On REQUEST-CHANGES: fix round to builder ses_e15ab4fdaffeG4J0W5xDjJnh2Y |
| **Heartbeat** | (background sleep) | RE-ARM after restart | Re-arm, then `bash scripts/lead-watchdog.sh` |

## QUEUED / PARKED
- **B0** — unblocks ONLY with the phone on adb + Martin's rulings (model license: HF says Apache-2.0, MediaPipe
  page says Gemma license; Martin decides before weights leave the machine). Card has the full probe checklist.
- **RECORDED-ONLY nits** (do NOT dispatch without Martin asking): C2's 6 sweep nits (done/C2.md), B7 N5/N8/N9
  (done/B7.md), A5-OFF-sync accepted nits (done/A5.md).

## Merge protocol (verbatim)
`gh pr merge <n> --merge` → `git pull --no-rebase` → `gh pr view <n> --json mergedAt` (VERIFY) →
`python3 kanban/board.py move <ID> done` (board.py commits; a chained manual commit no-ops) → push →
`git worktree remove --force ../scanlist-wt/<lane>` + `git branch -d card/<branch>` + `git push origin --delete card/<branch>`
→ rm reviewer clones → append evidence to the done card → lead-log entry → push.
Sync rounds: no card move; evidence on parent done card.

## Watchdog notes
- `scripts/lead-watchdog.sh`: open PRs + CI (timeout 60 per gh probe), card/* tip diff (transient ls-remote flap
  → "TRANSIENT" line, tips preserved), closed-unmerged audit (#34 PERMANENTLY waived — superseded by merged #37;
  any NEW closed-unmerged alarms), refs/tags/main count, release list, main.yml runs.
- Tips state file: /tmp/opencode/watchdog-tips.txt.

## Recent history (one line each — full detail in lead-log)
- A6-followup merged (PR #44): Settings mounted + persisted backend applied at startup + haptics wired; fix round
  made "no re-run on remount" TRUE (lastRunKey → controller — was a per-mount ref, would have re-run the 484 MB
  self-test) + hardware BackHandler. 33 suites / 381.
- apk-size merged (PR #45): the REAL lever `reactNativeArchitectures=arm64-v8a` (#42's build.gradle hunk was inert —
  RN plugin re-unions ABIs); APK 290.7 → 113.5 MiB, arm64-only verified from the artifact. Retro card done/apk-size.md.
- Martin merged his own lanes (#42/#43) pre-review — reviews ran post-merge and caught the inert #42 + #43's
  cold-start race + 4 risks → fix PRs #45/#46.
- X2 merged (PR #41): verdict Kotlin (provisional on B0), counter-argument web; one provenance blocker caught
  (web column mixed X1 branch-point timings with current bundle size) — fixed, 150/0 sanity re-run.
- A6 merged (PR #36) after two REQUEST-CHANGES rounds — round 2 blocker was real: quiet hint could never render
  (frame markers refreshed activity.image every ~400 ms); fixed with usefulness-based quiet.
- B7 merged (PR #39): 3 gating doc-honesty nits fixed; N7's surviving mutation (unpinned hysteresis defaults) killed.
- C2-followup merged (PR #40): URL-import whole-transfer timeout + orphan-doc sweep with real quarantine.
- Lead-B's one-hour deadline run (user 14:16Z → X2 merged 15:13Z = 57 min). Timing ledger: kanban/lead-timings.md.
- PR-34 incident (closeout omitted the merge) → watchdog closed-unmerged audit; CI incident (release job) closed earlier.
