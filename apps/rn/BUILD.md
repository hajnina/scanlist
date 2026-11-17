# Track A — React Native skeleton (`apps/rn`)

Bare React Native (no Expo), **new architecture**, TypeScript, Material 3 via `react-native-paper`,
themed to `references/bonsai-ui/STYLE_GUIDE.md`. App id **`dev.hajnina.scanlist.rn`**.

Card A1: build + run skeleton — no list parsing, camera, embedding or ranking yet (later cards).
This file lists **every** local override and hack, and what is deliberately not here.

## TL;DR build status

| Build | Command | Result |
|---|---|---|
| Laptop (aarch64 Linux) | `apps/rn/build.sh` | **see "Local build log" at the bottom** |
| CI (x86_64 ubuntu runner) | `.github/workflows/pr.yml` → `rn` job: `cd apps/rn/android && ./gradlew --no-daemon assembleDebug` | see the PR |

`apps/rn/build.sh` is the entry point on the laptop; plain `./gradlew assembleDebug` in
`apps/rn/android` is the same project without the four aarch64-only `-P` flags.

## Versions

| Item | Value | Where |
|---|---|---|
| React Native | 0.88.1 (latest stable, 2026-11) | `package.json` |
| React | 19.3.0 | `package.json` |
| react-native-paper | 5.15.5 (MD3) | `package.json` |
| New architecture | `newArchEnabled=true` | `android/gradle.properties` |
| Hermes | `hermesEnabled=true` | `android/gradle.properties` |
| Gradle | 9.4.1 (wrapper) | `android/gradle/wrapper/gradle-wrapper.properties` |
| AGP / Kotlin | whatever RN 0.88's Gradle plugin pins (9.x / 2.2) | resolved by `@react-native/gradle-plugin` |
| compileSdk / targetSdk / minSdk | 37 / 36 / 31 | `android/build.gradle` — minSdk 31 since A3 (LiteRT-LM requires ≥31, same as the Kotlin app) |
| build-tools | 37.0.0 | `android/build.gradle` |
| NDK (CI) | 27.1.12297006 (RN default) | `android/build.gradle` |
| NDK (laptop) | 30.0.16248370 (has linux-aarch64 prebuilts) | `-Pscanlist.ndkVersion` from `build.sh` |
| JDK | 17 (laptop, `scripts/android-env.sh`), 21 (CI) | — |

Only Android is shipped from this directory: the CLI's `ios/`, `Gemfile` and `.xcode.env` were
deleted (no Mac in this project, and every comparison target is an APK).

## How to build

```bash
# laptop (aarch64): sources scripts/android-env.sh itself
apps/rn/build.sh                 # assembleDebug -> android/app/build/outputs/apk/debug/app-debug.apk
apps/rn/build.sh assembleRelease # not on this laptop, see "Not done here"

# CI / x86_64 host: stock toolchain, RN's own defaults
cd apps/rn/android && ./gradlew --no-daemon assembleDebug

# JS side
cd apps/rn && npm install && npm run typecheck && npm test
```

Install: `adb install -r apps/rn/android/app/build/outputs/apk/debug/app-debug.apk`
then `npm start` (Metro) in `apps/rn` for the dev bundle.

## Overrides and hacks (all of them)

| # | What | Why | Where | Affects CI? |
|---|---|---|---|---|
| 1 | `-Pandroid.aapt2FromMavenOverride=<aarch64 aapt2>` | the SDK's Maven aapt2 is an x86_64 ELF and dies with "Exec format error" on this laptop | `scripts/android-env.sh` (`GRADLE_OPTS`), re-passed explicitly by `build.sh` | no — CI has no aarch64 toolchain, so the flag is absent |
| 2 | `-Pscanlist.ndkVersion=<version>` | RN 0.88's default NDK 27.1.x ships **x86_64-only** LLVM prebuilts; the new-arch C++ glue (`ReactAndroid/cmake-utils/default-app-setup/CMakeLists.txt`) cannot be compiled with it on aarch64. NDK 30.0.16248370 in the shared toolchain *does* have `toolchains/llvm/prebuilt/linux-aarch64` | `build.sh` (auto-detects the newest aarch64-capable NDK); `android/app/build.gradle` reads the property, defaulting to `rootProject.ext.ndkVersion` | no — property unset ⇒ RN's default 27.1.12297006 |
| 3 | `-PreactNativeArchitectures=arm64-v8a` | the debug APK only needs the phone's ABI; CMake otherwise builds 4 ABIs (4× the native work) | `build.sh` only | no — CI builds all four |
| 4 | `-Dorg.gradle.jvmargs=-Xmx3g …` | the shared Gradle slot lock (`~/projects/martins-whisper/owner/tools/gradle-slot.sh`) caps the daemon at 1.5 GB, which is not enough for AGP 9 + Kotlin + codegen | `build.sh` only | no |
| 5 | Throwaway debug keystore generated on demand | AGENTS.md: keystores never in git. RN's template signs with `android/app/debug.keystore` | `scripts/make-debug-keystore.sh` (keytool, alias `androiddebugkey`, password `android`, RSA 2048, 10 000 days, PKCS12); called by `android/app/build.gradle` when the file is missing **and** by `build.sh` | **yes** — the file is gitignored, so the Gradle call is what keeps CI signing; nothing secret is committed |
| 6 | `npm install` from `android/settings.gradle` when `node_modules` is missing | the lead-owned CI workflow builds `apps/rn/android` with a bare `./gradlew assembleDebug` and has no npm step, but RN autolinking + the included `:react-native` Gradle plugin live in `node_modules` (gitignored) | `android/settings.gradle` (first 20 lines) — idempotent one-off | **yes** |
| 7 | Shared SDK packages installed for RN 0.88 | RN 0.88 needs `platforms;android-37.0` + `build-tools;37.0.0`; the shared toolchain only had platform 35 / build-tools 35.0.1 | installed with `sdkmanager` into `~/projects/martins-whisper/android-toolchain/sdk` (additive; nothing else changes) | no |
| 8 | Gradle slot lock | host-wide memory discipline (max 2 concurrent Gradle builds across agents) | `scripts/android-env.sh` (`GRADLE_SLOT_SH`), honoured by `build.sh` | no |

Nothing above is baked into `android/build.gradle`, `android/app/build.gradle` or
`gradle.properties` as a laptop path: on CI the same project builds with RN's stock versions.

## Something for the lead (outside this card's `owns`)

* `scripts/android-env.sh` picks the **newest** `build-tools/*/aapt2` as the override. Because RN
  0.88 needs build-tools 37.0.0 (installed for this card), that newest aapt2 is again an x86_64
  binary. `apps/rn/build.sh` therefore re-selects an aarch64 aapt2 itself (hack 1); a general fix
  belongs in `scripts/android-env.sh` (prefer an aarch64-ELF aapt2 over "newest").

## Not done here (deliberate)

* **Screens** — exactly one static skeleton screen (`src/list/ui/HomeSkeleton.tsx`) that shows the
  style-guide look; list import, nested sections, scan overlay and settings are later cards.
* **Dynamic colour (Material You)** — Paper 5 has no dynamic-colour API; it needs a small native
  module over `androidx.core`'s `dynamicDarkColorScheme`. The guide's fallback teal seed is used.
* **Icons** — the style guide uses no icon font, so `react-native-vector-icons` is not installed
  (Paper's `Icon` would need it).
* **Real haptics** — `src/ui/haptics.ts` uses RN's `Vibration` with the five guide intents
  (Confirm / ToggleOn / ToggleOff / Reject / LongPress) instead of `HapticFeedbackConstants`.
* **`modules/embed`** — directory + `Embedder` contract only; no TurboModule, no model weights
  (weights live in `~/models/scanlist/` and are gitignored anyway).
* **Release builds on this laptop** — `assembleRelease` bundles JS through `hermesc`, which RN
  downloads as a **linux-x86_64** binary; it cannot run on aarch64. Release is a CI job.
* **iOS** — deleted, see above.

## Layout

```
apps/rn/
  build.sh                     # laptop entry point (aarch64 overrides)
  BUILD.md                     # this file
  scripts/make-debug-keystore.sh
  index.js                     # AppRegistry -> src/App
  src/
    App.tsx                    # providers only (SafeArea + Paper MD3 + StatusBar)
    theme/                     # tokens.ts (springs/shapes/type), scanlistTheme.ts, index.tsx provider
    ui/                        # ExpressiveCard, ScanButton, SpringIn, Typography, haptics
    list/                      # nested-JSON types + ui/HomeSkeleton.tsx (the only screen so far)
    scan/sources/              # ScanSource / ScanSignal contract
    scan/ui/                   # reserved for the camera overlay
    settings/                  # Settings shape + architecture defaults
  modules/embed/               # reserved: EmbeddingGemma 2 TurboModule (wraps shared/android-embed)
  android/                     # RN 0.88 Android app, id dev.hajnina.scanlist.rn
```

## Style-guide mapping (short)

* `src/theme/tokens.ts` — the guide's §3 spring constants expressed as `Animated.spring`
  parameters (`damping = ζ·2·√stiffness`, mass 1), the asymmetric dp radii, spacing, Black weights.
* `src/theme/scanlistTheme.ts` — MD3 light/dark schemes from the guide's teal/amber seed,
  `surfaceContainer*` tonal roles Paper does not have, Black (900) display/headline/title variants.
* `src/ui/*` — press scale 1 → 0.94 (`fastSpatial`), corner morph 28 ↔ 64 dp on the scan surface,
  staggered `springIn` entrance, caps labels with 1.5 tracking, monospace machine text, haptics on
  every action.

## Local build log

```
$ apps/rn/build.sh                       # 2026-11-16, aarch64 laptop, 8 cores, 14 GB free
build.sh: aarch64 aapt2 override .../sdk/build-tools/35.0.1/aapt2
make-debug-keystore: .../android/app/debug.keystore exists — leaving it alone
build.sh: using aarch64-capable NDK 30.0.16248370 (override; CI uses RN's default)
[gradle-slot] got slot 1/2 after 0s; running: .../gradlew --no-daemon assembleDebug ...
BUILD SUCCESSFUL in 8m 35s
87 actionable tasks: 86 executed, 1 from cache
build.sh: OK 38M .../android/app/build/outputs/apk/debug/app-debug.apk
```

APK checks (`aapt2 dump badging`, `unzip -l`):

```
package: name='dev.hajnina.scanlist.rn' versionCode='1' versionName='1.0'
         compileSdkVersion='37' minSdkVersion='24' targetSdkVersion='36'
uses-permission: INTERNET, CAMERA, VIBRATE, SYSTEM_ALERT_WINDOW, ACCESS_LOCAL_NETWORK
lib/arm64-v8a/libappmodules.so            439 800 B   # new-arch C++ glue, compiled here
lib/arm64-v8a/libreactnative.so        24 062 944 B
```

A3 update (2026-11-17): the TurboModule card wired `shared/android-embed` into the app, so the
APK grows 38M → 71M (the LiteRT-LM JNI lib `liblitertlm_jni.so` is packaged for arm64-v8a and
x86_64 only — the CI all-ABI APK is 178 MiB; on armeabi-v7a/x86 the app installs but engine
calls reject as `E_EMBED`, no crash) and
`minSdkVersion` is now `31`. CI `rn` job green on the A3 head in 2m42s. Dev screen:
`apps/rn/src/dev/` (hidden dev affordance; shows backend/dims/latency or `E_NO_BACKEND` until
card B0 provisions the model on device).
lib/arm64-v8a/libhermesvm.so            4 021 008 B
lib/arm64-v8a/libreact_codegen_safeareacontext.so
```

JS checks: `npm run typecheck` (tsc, clean), `npm test` (1 suite / 1 test passed),
`npx eslint .` (clean).

Reproduce from scratch: delete `node_modules`, `android/app/build`, `android/.gradle`,
`android/app/debug.keystore` — `build.sh` recreates all of them (npm install, CMake build,
keytool) with no further input.

Not verified on hardware: no APK was launched — the shared toolchain's `platform-tools/adb` is an
x86_64 binary (it dies under qemu with "Could not open /lib64/ld-linux-x86-64.so.2"), and no phone
was attached anyway. The APK was built and inspected (`aapt2 dump badging`, `unzip -l`) only.

