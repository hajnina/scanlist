# Releasing the React Native app (`apps/rn`)

Audited 2026-11-17 against `main` @ `e2ac733`. Scope: configuration only — this host is aarch64 and
cannot run `hermesc`, so **no release APK was built or installed while writing this**. Every claim
below is from the checked-in Gradle/manifest/workflow files and the resolved React Native Gradle
plugin (`react-native-gradle-plugin.jar`, RN 0.88), with file:line.

## The contract

| | Debug | Release |
|---|---|---|
| Task | `./gradlew assembleDebug` | `./gradlew assembleRelease` |
| Output | `app/build/outputs/apk/debug/app-debug.apk` | `app/build/outputs/apk/release/app-release.apk` |
| JS | **none** — loads from Metro at runtime | `assets/index.android.bundle`, Hermes bytecode |
| Standalone | no — needs Metro over USB/Wi-Fi | yes |
| Purpose | dev loop | **the only shippable artifact** |

`assembleDebug` is not a smaller release build; it is a different packaging mode. RN's Gradle plugin
skips bundling for `debuggableVariants`, whose default is `["debug", "debugOptimized"]` (the
`debuggableVariants` line in `android/app/build.gradle:24` is commented out, so the default applies).
`release` is not in that list and the build type is not `debuggable`, so the
`createBundleReleaseJsAndAssets` task runs and writes `assets/index.android.bundle` into the APK.

## Merge order: PR #47 flips CI to release

Before #47, `main`'s `rn` CI job builds `assembleDebug` and the rolling release therefore carries a
Metro-only APK. **PR #47** changes that: `assembleRelease`, upload `ScanList-rn-release.apk`, a gate on
`assets/index.android.bundle`, plus an `rn-smoke` job. This document describes the pipeline **after
#47**; #47 must land first (or with this change), otherwise the statements about CI below are false
for that commit.

## Build (x86_64 host or CI runner)

```bash
cd apps/rn/android
./gradlew --no-daemon assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

Do not use `apps/rn/build.sh assembleRelease`: `apps/rn/build.sh:21` is just the default-task line
(`${1:-assembleDebug}`), and its report step only looks for
`app/build/outputs/apk/debug/app-debug.apk` (`apps/rn/build.sh:103-108`), so it either fails after a
successful release build or reports a stale debug APK as `OK`.

On the aarch64 laptop release cannot be built at all: RN's `hermesc` artifact is linux-x86_64
(`apps/rn/BUILD.md` §"Not done here").

## Verify before publishing

```bash
apk=app/build/outputs/apk/release/app-release.apk
unzip -l "$apk" | grep assets/index.android.bundle    # must print exactly one line
unzip -Z1 "$apk" 'lib/*' | cut -d/ -f2 | sort -u      # must print only arm64-v8a
aapt2 dump badging "$apk" | head -1                   # package name='dev.hajnina.scanlist.rn'
```

Then install on a phone (`adb install -r "$apk"`), turn off Wi-Fi, launch: the list screen must render.
The red box **"Unable to load script. Make sure you're running Metro or that your bundle
'index.android.bundle' is packaged correctly for release."** (RN 0.88.1 `JSLoader.cpp:81`) is not a
debug-build detector by itself: a release APK with a missing/stale bundle shows the same box, and so
does a debug app without `adb reverse`. The `unzip` check is the discriminator — a debug APK has no
`assets/index.android.bundle` at all.

Measured arm64-only artifact so far (CI run 44125373999, `card/apk-size`): 118,965,591 B (113.5 MiB),
`arm64-v8a` only. That was the **debug** APK; a release APK is that plus the Hermes bundle (a few MB).
The post-#47 `ScanList-rn-release.apk` is the authority for the real release size.

## Configuration audit (release build)

| # | Area | Evidence | Verdict |
|---|---|---|---|
| 1 | JS bundling | `debuggableVariants` default in RN plugin; `android/app/build.gradle:24` (commented) | **OK** — release bundles `assets/index.android.bundle` |
| 2 | Manifest placeholder `android:usesCleartextTraffic` | `AndroidManifest.xml:18`; RN plugin `AgpConfiguratorUtils` sets it per build type (`true` debug, `false` release) | **OK** — no "placeholder not found" failure; release forbids cleartext |
| 3 | Network under cleartext=false | OFF redirects must stay HTTPS (`src/scan/ui/off.ts:391`), model download is HTTPS (`embed/ModelDownload.kt:414`) | **OK** — no plain-HTTP endpoint in the app |
| 4 | Signing | `android/app/build.gradle:141` → `signingConfigs.debug`, keystore `android/app/debug.keystore` generated on demand (`:84-101`, `scripts/make-debug-keystore.sh`) | **signed, installable; NOT store-ready** — identity is the public Android debug key |
| 5 | Hermes | `hermesEnabled=true` (`android/gradle.properties:42`), `hermes-android` dependency (`android/app/build.gradle:163-167`) | **OK** — release compiles bytecode; needs an x86_64 build host for `hermesc` |
| 6 | Minify / R8 | `enableProguardInReleaseBuilds = false` (`android/app/build.gradle:60`, applied at `:142`) | **OK** — nothing is stripped, so no release-only reflection/missing-class breakage; APK stays large |
| 7 | New architecture | `newArchEnabled=true` (`android/gradle.properties:38`) | **OK** — same native build as debug; CI's default NDK 27.1 compiles it |
| 8 | ABI | `reactNativeArchitectures=arm64-v8a` (`android/gradle.properties:31`) + `abiFilters 'arm64-v8a'` (`android/app/build.gradle:123`) | **OK for phones, arm64 only** — won't install on x86_64 emulators (see `README.md`) |
| 9 | Startup path | `MainApplication.kt:14-23,28` (`loadReactNative`, `getDefaultReactHost`), `MainActivity.kt:20-21` (`DefaultReactActivityDelegate`) — stock RN entry points, no dev-server code | **OK** — packaged-asset loader is selected when `BuildConfig.DEBUG` is false |
| 10 | Version | `versionCode 1`, `versionName "1.0"` (`android/app/build.gradle:113-114`) | **gap** — every build claims v1.0; fine for side-loading, wrong for any ordered distribution |

No release-only override is missing: the release build type differs from the RN template only by
signing with the debug key (`:141`) and inheriting the same `defaultConfig`.

## The defect #47 fixes: CI currently publishes the debug APK

Until #47 lands, the public "React Native APK" on the rolling release is the debug build:

* `.github/workflows/main.yml:160` — rn job runs `./gradlew --no-daemon assembleDebug`
* `.github/workflows/main.yml:165` — renames it to `ScanList-rn-debug.apk`
* `.github/workflows/main.yml:169-170` — uploads artifact `scanlist-rn-apk`
* `.github/workflows/main.yml:227-288` — release job downloads `scanlist-*` and attaches `rel/*` to
  the `rolling` GitHub release

So a fresh install of that asset has no bundle and shows the red box. The filename does say `debug`,
but the release notes just say "React Native APK". **PR #47** replaces this with `assembleRelease` →
`ScanList-rn-release.apk` and a bundle-check gate. `.github/` is lead-owned (AGENTS.md), so this card
does not change it.

The same pattern applies to the Kotlin APK (`main.yml:88` builds `assembleDebug`) — out of scope here,
reported for the lead.

## Not verified here

* No `assembleRelease` run and no `app-release.apk` on this host (aarch64 `hermesc`). The release
  artifact will first be produced by the #47 CI job; until then its size/content is unmeasured.
* No on-device launch (no phone attached, and the shared toolchain's `adb` is x86_64-only).
