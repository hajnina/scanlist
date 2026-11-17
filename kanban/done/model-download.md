# model-download — RN in-app resumable model download (retro card)

> Created post-hoc by lead-A: the ORIGINAL dispatch (PR #43) had no kanban card and no log entry — Martin
> dispatched bare and merged pre-review himself. Card content reconstructed from the PR bodies + the full
> adversarial-review chain. Fix round = PR #46, lead-A's chain.

## Card
RN device path: the 484 MB EmbeddingGemma `.litertlm` bundle can't ship in the APK (weights live out-of-tree).
In-app download: resumable (HTTP Range), sha256-verified before swap, app-private storage, surfaced through the
ScanScreen model-missing guidance (replacing the adb-push-only story with a first-class path — push stays as
fallback). Target file `apps/rn/android/.../embed/ModelDownload.kt` + JS guidance wiring.

## Done when
Download, resume (mid-stream kill → continue from bytes-on-disk), sha-mismatch refusal (corrupt download NEVER
swapped), single-flight, and guidance states all real; JVM tests prove each; CI APK build green.

## Evidence
### PR #43 (merged by Martin pre-review, 16:11:59Z — mergedAt verified)
- 10 files: new `ModelDownload.kt` (484,622,336 B download, sha256 `e7a8a220…7f4c` over `.part`, `renameTo`
  only on match, mismatch deletes, 2nd mismatch terminal) + `EmbedModule` init + `NativeEmbed.ts` +
  ScanScreen/guidance wiring + `scripts/model.sh` `push` subcommand.
- **Post-merge adversarial verdict (REQUEST-CHANGES, lead-A reviewer)**: substantively SOLID — no weights/secrets
  in git (largest blob 19,578 B); expected sha matches HF API blobs (`size 484622336, lfs e7a8a220…7f4c`);
  resume verified against the REAL transport through HF's 302→CDN (`offset=4000 → 206 bytes 4000-484622335/484622336`,
  `offset=0 → 200`); storage app-private (`filesDir`); no permission creep; mutations bite (sha-off → 2 fail,
  offset-0 → 2 fail). Plus 1 real race bug + 4 risks → 6-item fix list.

### PR #46 (model-download-fix, lead-A prescribed-fix lane, MERGED 17:05:54Z mergedAt-verified)
- All six review items fixed and re-verified by the same reviewer (APPROVE, head `7493c25`):
  1. **URL revision-pinned** to `/resolve/66011bd4…b4881/` in `ModelDownload.kt` AND `scripts/model.sh`
     (HF confirmed the pin is current; pinned-revision API → size+sha match `MODEL_SHA256`; real-transport
     probes 200 + 206 pass; re-pin recipe documented at the constant).
  2. **Disk-space pre-check** (`spaceShortage()`, StatFs): before start AND every resume attempt; shortage →
     TERMINAL `FAILED` "not enough free space", transport never opened; 512 MiB margin documented + tested.
  3. **Metered honesty** via minimal copy fix (documented choice over a gate): "One-time 484 MB over the
     network; if it stops, it resumes where it left off." — no "Wi-Fi" claim remains anywhere.
  4. **Cold-start race fixed**: `start()` publishes DOWNLOADING synchronously before the worker; injected
     `launch` makes the test deterministic; `modelPolling.test.ts` pins the JS half (6 cases).
  5. **adb-push hint restored** on failed; `cmd_push()` verified real (`model.sh:272`).
  6. **Single-flight tested** (3× start ⇒ 1 launch/1 transfer; post-READY start adopts).
- Mutations (all bite): revision→main pin → 1 fail; spaceShortage removed → 2 fail; sync publish removed → 1 fail.
- Gates: tsc 0 · jest **33 suites / 373** · eslint 0 · JVM ModelDownloadTest **14/14** · CI rn pass 5m26s on
  `7493c25`. Integration scratch-merge vs current main: **34 suites / 388 tests**, tsc/eslint/gradle clean.
- Worktree `../scanlist-wt/MODELDL` + branches `card/model-download-fix` / `card/model-download` deleted
  local + remote.

## Notes
- Process lesson recorded: pre-verdict self-merge (#43 by Martin) shipped the race bug + 4 risks; the
  post-merge review caught them and PR #46 closed every one before the feature was ever exercised on a phone.
- RECORDED-ONLY nits (no dispatch unless Martin asks): (a) missing separator in the failed-state copy —
  "…available Or push it"; (b) space-`FAILED` is process-terminal — no in-app retry until relaunch (arguably
  correct: disk state rarely changes mid-session; relaunch is cheap).
- B0 device verification (actual 484 MB download on the phone) remains parked WITH MARTIN per the B0 card.
