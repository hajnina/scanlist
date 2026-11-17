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
| X2 review (timeboxed to 12 min) | `…LzqBjek0U2OXar` | 14:33 | 14:56 | **23 min** | REQUEST-CHANGES: 1 provenance blocker; 150/150 checks green |
| X2 provenance fix (boxed to 8 min) | `…15SZAnuhPFy9xt` | 15:02 | 15:12 | **10 min** | pushed; 150/150 re-run; one mechanical main-integration (2 min) |
| Lead merge + closeout (per PR) | — | — | — | **2-3 min** | merge → mergedAt → board move → cleanup |
| Lead heartbeat cycle | — | — | — | **1-2 min** | re-arm + watchdog |

## What the numbers say (early, small sample)
- **Adversarial reviews of a real PR: 8–35 min**, dominated by mutation runs and suite re-runs. A doc-only review was 8 min; a 6-blocker behavioural re-review 31 min; a Kotlin review with 3 mutations 34 min.
- **Builders: 14–55 min.** A focused fix round with a clear prescription = ~14 min. A from-scratch deliverable (X2 doc) = ~55 min. Scope creep inside a fix round roughly doubles it (17 → 23 min once optional items were picked up).
- **Timeboxing works**: the 20-min box on A6 fix 2 delivered in 14 min; the scope-cut message on B7 stopped the optional tail from dominating the closeout.
- **Estimate rule of thumb**: fresh reviewer ≈ 30 min + 15-19 min RN CI if the PR is RN; builder ≈ 15 min per review-driven fix round, ≈ 45-60 min per new deliverable; lead closeout ≈ 3 min.

## Deadline run (2026-11-17, "one hour" instruction at 14:16Z)
- Result: **X2 merged 15:13:09Z = 57 min** from the instruction, with two REQUEST-CHANGES rounds (A6 real blocker, X2 provenance) and one branch integration.
- What made it fit: timebox messages on every lane (A6 fix 20-min box → 14 min; B7 nits scope-cut mid-run; X2 fix 8-min box → 10 min), gating nits only for B7, and lead closeouts kept at 2-3 min.
- What nearly broke it: RN CI is 15-19 min per head — any RN fix round inside a 60-min window must be pushed within the first 20 min, or the merge slips. Fresh reviews are 20-35 min, so **only one review round per PR fits in an hour**; a second round needs the reviewer to be pre-briefed and the fix to be reviewer-prescribed.

## Live milestone (2026-11-17, 20-min box at 15:47Z): model download + APK size
| Lane | Dispatched | Delivered | Duration | Outcome |
|---|---|---|---|---|
| Downloader, first shippable push | 15:51 | 16:03 | **12 min** | WIP branch (no tests yet) |
| Downloader, blocker fixes (reviewer-prescribed) | 16:07 | 16:12 | **5 min** | 4/4 blockers, 9/9 JVM tests |
| Downloader review (fresh) | 16:00 | 16:07 | **7 min** | REQUEST-CHANGES, 3 real bugs + hanging test |
| Downloader re-verify (delta) | 16:08 | 16:11 | **3 min** | APPROVE-WITH-NITS, independently reran 9/9 |
| ABI PR #42 builder (incl. CI) | 15:51 | 16:18 | **27 min** | merged but INEFFECTIVE; APK still 304 MB |
| ABI real fix PR #45 builder (incl. CI) | 16:19 | 16:33 | **14 min** | 118,965,591 B, arm64-only verified |
| Main CI → release asset | 16:39:57 | 16:46:24 | **6m31s** | 118,965,591 B live |

**What the numbers say**
- A from-scratch, correctly-reviewed downloader is **~35 min minimum**: 12 min to a pushable skeleton + 7 min
  review + 5 min prescribed fixes + 3 min re-verify, with CI overlapping. The 20-min box was arithmetically
  infeasible once robustness (resume/verify/retry) was required.
- A packaging change looks like 2 lines but needed **two iterations (27 + 14 min)** because the framework silently
  overrode the first mechanism. CI was the only possible verifier on this aarch64 laptop.
- **Always measure the artifact's contents, not its zip size.** The 107 MB artifact contained the unchanged
  304 MB APK; one wrong merge and one wrong user-facing number came from that.
- One ABI also cuts RN CI from 16–19 min to **~6.5 min**, which materially changes future estimates.
