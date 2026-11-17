# apk-size — RN arm64-only APK (retro card)

> Created post-hoc by lead-A: this lane was dispatched WITHOUT a kanban card (no card, no dispatch entry —
> process gap flagged in the lead-log cycle 17). Card content reconstructed from the PR bodies + review evidence
> so the audit trail is complete. Owner of the original dispatch: Martin (merged #42 himself).

## Card
RN APK ships 4 ABIs (arm64-v8a 77.9 MB + armeabi-v7a 35.9 + x86 58.2 + x86_64 82.7 = 267 MB lib/ = 87.6% of the
291-305 MB APK) for a target device (B0 phone) that is arm64-only. Ship arm64-v8a only.

## Done when
CI-built APK contains ONLY arm64-v8a and the size drop is verified from the artifact.

## Evidence (lead-A, 2026-11-17)
- **PR #42 (merged pre-review by Martin, 16:17:39Z)** edited `app/build.gradle` ndk abiFilters — VERIFIED INERT by
  adversarial review: RN's gradle plugin re-unions ABIs from `gradle.properties:28 reactNativeArchitectures`
  (NdkConfiguratorUtils.kt:62, finalizeDsl). CI artifact of the PR head was byte-identical to baseline (+16 KB).
- **PR #45 (apk-size-fix, lead-A prescribed-fix lane, MERGED 16:39:55Z mergedAt-verified)**: the real lever —
  `reactNativeArchitectures=arm64-v8a` in gradle.properties + doc arithmetic corrections (BUILD.md "178 MiB" was an
  A3-era number; README 267 MB framing corrected; x86_64-emulator wording corrected).
- **Artifact proof (lead verified from CI run 44125373999, head e349ec4)**: `ScanList-rn-debug.apk` = 118,965,591 B
  = **113.5 MiB** (was 304,813,824 B ≈ 290.7 MiB); `unzip -l` per-ABI: **arm64-v8a ONLY** (20 lib entries, zero
  v7a/x86/x86_64); arm64 lib total 77.9 MB matches the reviewer's table exactly.
- rn CI pass (tsc + jest + APK build) on the merge head; kotlin/shared/web skipped by path filter.
- Real cut: ~177 MB of unused ABIs removed; docs now state the true numbers.

## Notes
- Merge-order ledger (closed): #42 (ndk abiFilters ~112-124) vs #43 (dependencies ~158) hunks non-overlapping — both in main.
- The 113.5 MiB APK beats the reviewer's ~128 MB prediction.
- No JS behavior change; gradle.properties + docs only. Baseline suite 32/364 unchanged.
