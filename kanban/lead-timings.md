# Lead timing ledger — how long subagent work actually takes

Recording started 2026-11-17 14:43Z (at the lead's request, for better time-boxing).
All times UTC. "Delivered" = the subagent's completion notification.

| Lane | Session (tail) | Dispatched | Delivered | Duration | Outcome |
|---|---|---|---|---|---|
| C2-followup review | `…RKiFvbtX1wbHlb` | 13:40 | 13:48 | **8 min** | APPROVE-WITH-NITS, 290 tests, 2 mutations |
| A6 review (fresh, 6 blockers) | `…X6geWskfWSGy7J` | 13:40 | 14:11 | **31 min** | REQUEST-CHANGES (1 real blocker found) |
| B7 review (fresh) | `…f0SfOFkbX0bnEs` | 13:40 | 14:14 | **34 min** | APPROVE-WITH-NITS, 326 tests, 3 gate nits |
| X2 builder (COMPARISON.md) | `…15SZAnuhPFy9xt` | 13:40 | 14:35 | **55 min** | PR #41, 150/150 number checks |
| A6 fix round 2 (timeboxed to 20 min) | `…vG9Bg3oxf2lHRU` | 14:13 | 14:27 | **14 min** | pushed, 352 tests, both mutations bite |
| B7 prescribed nits (timeboxed, scope-cut mid-run) | `…EUkHEY378VYu4v` | 14:20 | 14:43 | **23 min** | pushed, 329 tests (also took optional N3/N7 wiring) |
| A6 re-verify (timeboxed to 15 min) | `…LTyRMAQS7AQfgV` | 14:27 | 14:52 | **25 min** | APPROVE; 352 tests; 2/2 mutations; rn CI 19m16s was the tail |
| Lead merge + closeout (per PR) | — | — | — | **2-3 min** | merge → mergedAt → board move → cleanup |
| Lead heartbeat cycle | — | — | — | **1-2 min** | re-arm + watchdog |

## What the numbers say (early, small sample)
- **Adversarial reviews of a real PR: 8–35 min**, dominated by mutation runs and suite re-runs. A doc-only review was 8 min; a 6-blocker behavioural re-review 31 min; a Kotlin review with 3 mutations 34 min.
- **Builders: 14–55 min.** A focused fix round with a clear prescription = ~14 min. A from-scratch deliverable (X2 doc) = ~55 min. Scope creep inside a fix round roughly doubles it (17 → 23 min once optional items were picked up).
- **Timeboxing works**: the 20-min box on A6 fix 2 delivered in 14 min; the scope-cut message on B7 stopped the optional tail from dominating the closeout.
- **Estimate rule of thumb**: fresh reviewer ≈ 30 min + 15-19 min RN CI if the PR is RN; builder ≈ 15 min per review-driven fix round, ≈ 45-60 min per new deliverable; lead closeout ≈ 3 min.
