# shippability-tail — make the RN APK actually shippable (retro card)

> Created post-hoc by lead-A: three bare-dispatch lanes by the repo owner (no kanban cards), all merged by him
> (mergedBy hajnina — #49 at 20:43:45Z, #47 at 22:14:42Z, #48 at 22:14:52Z; all mergedAt-verified). Card content
> reconstructed from the PR bodies + the adversarial-review chain. Lead-A ran the reviews; the owner applied the
> review fixes himself before merging.

## The incident that started it
The rolling release APK published on main all day (the artifact-verified arm64-only 113.5 MiB one) contained
**NO `assets/index.android.bundle`** — CI built `assembleDebug` (Metro-only). Installed, it shows the RN
"Unable to load script" box and cannot run. Lesson recorded: **size/ABI verification ≠ launchability** —
nobody had ever launched a published artifact. (Erratum: "Metro can't load the script" is NOT a real RN
string; the actual text is *"Unable to load script. Make sure you're running Metro or that your bundle
'index.android.bundle' is packaged correctly for release."* — JSLoader.cpp:81.)

## The three lanes
### PR #47 (ci-standalone) — the fix + the proof gate
- `rn` jobs (PR + main) build **`assembleRelease`** (bundled + Hermes-compiled JS, debug-keystore signed,
  ProGuard off) → `ScanList-rn-release.apk`.
- **Standalone gate**: fails unless the APK has `assets/index.android.bundle` >100 kB and only `lib/arm64-v8a`.
- **`rn-smoke` job**: same release variant built with `-PreactNativeArchitectures=x86_64`, boots an API 34
  x86_64 emulator **on CI** (sidesteps the aarch64-laptop limitation), installs, `am start -W` must print
  `Status: ok`, pid must stay alive 15 s, no `FATAL EXCEPTION` in logcat, screenshots required (Lists /
  Paste-JSON dialog / Settings via real uiautomator labels), artifact `rn-screens` (named so it can never
  leak into the rolling release, which downloads `scanlist-*` only). Logic lives in `scripts/rn-smoke.sh`.
- **Review rounds (lead-A)**: round 1 (head a7a4ad6) — "Magic scan" uiautomator label doesn't exist anywhere
  live (only dead HomeSkeleton.tsx). Round 2 (head 259ef2d, smoke extracted to the script) — **REQUEST-CHANGES
  with a reproduced blocker**: `set -euo pipefail` + `grep -q` on big streams is a SIGPIPE trap — the smoke job
  failed 10 ms in with "no JS bundle" WHILE gradle's log showed the bundle built (run 44168106312); the same
  trap made the FATAL-EXCEPTION grep silently always-false. Fix (owner): stream-then-grep (`unzip -l`/`logcat`
  to temp files, grep the files) + `|| true` on pidof. Round 3 (head 72ead20): **APPROVE-WITH-NITS** —
  labels all real (`Paste JSON` ImportCard.tsx:117, `Cancel` :140, `Settings` ListsScreen.tsx:147, back-assert
  `Shopping list` :132), screenshots mandatory (test -s each), CI rn pass 6m16s + **rn-smoke pass 10m15s**,
  `rn-screens` artifact = 3 screenshots + `launch.txt` (`Status: ok`, COLD, 930 ms), SMOKE PASS pid=3877.
- Verified final-head shipping APK: **92,834,803 B, HBC magic c61fbc03, 1,524,428 B JS bundle, 20×
  lib/arm64-v8a, standalone OK**.
- Nits recorded (non-blocking): latent pipefail abort if a build ever ships no `lib/` (can't happen today);
  mktemp files never removed; logcat files not in the artifact.

### PR #48 (release-docs) — the docs must not lie
- Docs-only: BUILD.md Shipping-vs-Dev split, warning box for the debug-APK signature, RELEASE.md (new).
- **Verdict: REQUEST-CHANGES (5 fixes, posted to the PR)** — wrong error quote (real RN string above, 5
  places) + "shows X ⇒ debug APK" is invalid inference (discriminate via unzip); name the **#47 merge-order
  dependency** (the docs' CI claims flip when #47 lands); add `adb reverse tcp:8081` to the USB dev flow;
  two line-range fixes; verify-snippet paths. Verified good meanwhile: release buildType config real
  (debug signing, ProGuard off, no flavors, bundling via `debuggableVariants` default), and — important —
  **`hermesc` ships no aarch64 binary → local release builds are impossible on this laptop; the CI-only
  release path is correct**.
- Owner applied the fixes (`cfc0080`) and merged. #47 merged BEFORE #48 as directed.

### PR #49 (app-icon) — a real mark
- Adaptive icon: solid `#10261C` bg, 108×108 vector fg (shopping-list card: 2 bold open bars + 1 ticked,
  camera-scan corner brackets, amber magic-scan spark), `<monochrome>` layer for themed icons, 10 legacy
  mipmaps (48/72/96/144/192 ladder), preview PNG (1024², 121 KB).
- **Verdict: APPROVE (posted to the PR)** — aapt2 compile+link OK, safe-zone honored (bracket r=33.33 dp,
  2.67 dp inside the real mask window), raster==vector IoU 0.996, manifest/build.gradle untouched, themed
  layer safely ignored pre-33, rn pass 5m41s.
- Risks recorded (non-blocking): **cross-track mark divergence** (RN icon ≠ Kotlin/web marks — one shared
  mark recommended before B0 screenshots feed any comparison doc); raster unreproducible (design SVG +
  render script not committed).

## Closeout (lead-A, post-restart reconciliation)
- All three merged by the owner during a server-restart window; local main fast-forwarded 814d625 → 29e7cbd
  (a stale untracked pre-fix `scripts/rn-smoke.sh` draft was removed — origin carries the reviewed version).
- Worktrees ICON/CI/RELDOCS (clean) + local branches deleted; origin `card/*` = **ZERO**.
- **Post-restart SSH incident (fixed)**: pushes started failing "access rights" — the server restart changed
  SSH key precedence: the plain `github.com` remote now resolved to the **gutiva** key (account without write
  access) instead of **hajnina**. Fixed repo-locally: `git config core.sshCommand "ssh -i
  ~/.ssh/id_ed25519_github_personal -o IdentitiesOnly=yes"`. Alternative for the owner: use the
  `github-personal`/`github-gutiva` ssh-config aliases in remote URLs. Lesson: **after any restart, verify
  `ssh -T git@github.com` resolves to the expected account before pushing**.
- First main release with the real pipeline: run 44188142594 (the #48 merge push; the #47 merge run was
  cancelled as superseded) — expected to publish `ScanList-rn-release.apk` + run rn-smoke on main. Evidence
  verification next watchdog cycle.
- Standing-rule candidates: (1) after a restart, check the SSH identity before pushing; (2) never
  `big-stream | grep -q` under `set -o pipefail` — redirect to a file, then grep.

## Notes
- B0 (physical device) remains the final device gate — the emulator smoke is the CI proxy, not a replacement.
- No board card moved (all three lanes were extra-board hardening).
