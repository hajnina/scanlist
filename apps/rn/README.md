# ScanList — React Native app

Build, test and packaging notes: [`BUILD.md`](BUILD.md). Release/shipping rules and the
configuration audit: [`docs/RELEASE.md`](docs/RELEASE.md).

## Which APK to install

| Artifact | Built by | Install it? |
|---|---|---|
| `android/app/build/outputs/apk/release/app-release.apk` | `./gradlew assembleRelease` | **Yes — the shipping build.** Contains `assets/index.android.bundle` (Hermes bytecode); runs standalone, no Metro. |
| `android/app/build/outputs/apk/debug/app-debug.apk` | `./gradlew assembleDebug` / `apps/rn/build.sh` | Dev only. **No JS bundle**: it loads JS from Metro, so without a reachable dev server it shows RN's red box *"Unable to load script…"*. Never publish or hand it out. |

`assembleDebug` is the local dev loop, not a deliverable. Until **PR #47** lands, CI is debug-only on
`main`; #47 switches the `rn` job to `assembleRelease` (artifact `ScanList-rn-release.apk`, gated on
the bundle check). Before publishing any APK, prove it is a release build:

```bash
apk=app/build/outputs/apk/release/app-release.apk
unzip -l "$apk" | grep assets/index.android.bundle   # must print one line
unzip -Z1 "$apk" 'lib/*' | cut -d/ -f2 | sort -u     # must print only arm64-v8a
```

(The red box is not proof either way: a release APK with a missing bundle shows the same text, and so
does a debug app without `adb reverse tcp:8081 tcp:8081`. The missing
`assets/index.android.bundle` is the decisive difference.)

The release build type is signed with the generated throwaway debug key
(`android/app/build.gradle:141`), which is fine for side-loading and **not** for store distribution.

## Device APKs are arm64-v8a only

The app packages a single ABI. `android/gradle.properties` sets `reactNativeArchitectures=arm64-v8a`,
which the React Native Gradle plugin appends to `defaultConfig.ndk.abiFilters` in `finalizeDsl`;
`android/app/build.gradle` repeats `ndk { abiFilters 'arm64-v8a' }` to document the intent (listing four
ABIs in `gradle.properties` previously widened that filter back to four). The last measured arm64-only
artifact (CI run 44125373999, debug) was 118,965,591 B (113.5 MiB); the four-ABI debug APK before it was
304,813,824 B (290.7 MiB), of which 267,084,660 B was `.so` files and only 81,671,640 B of that was the
`arm64-v8a` slice. A release APK is that arm64-only build plus the Hermes JS bundle (a few MB) — the
post-#47 `ScanList-rn-release.apk` is the authority for the real number. Trade-off: the APK will not
install on an x86_64 emulator (`INSTALL_FAILED_NO_MATCHING_ABIS`). For emulator work, use an
`arm64-v8a` system image, or temporarily add `x86_64` to both `reactNativeArchitectures` and
`abiFilters` and rebuild — and drop it again before shipping a device APK.

This applies to the release artifact too: `app-release.apk` is `arm64-v8a` only, so the phone must be
64-bit ARM (every current phone is; emulators usually are not).
