# ScanList — React Native app

Build, test and packaging notes: [`BUILD.md`](BUILD.md).

## Device APKs are arm64-v8a only

The app packages a single ABI. `android/gradle.properties` sets `reactNativeArchitectures=arm64-v8a`,
which the React Native Gradle plugin appends to `defaultConfig.ndk.abiFilters` in `finalizeDsl`;
`android/app/build.gradle` repeats `ndk { abiFilters 'arm64-v8a' }` to document the intent (listing four
ABIs in `gradle.properties` previously widened that filter back to four). The measured four-ABI debug
APK was 304,813,824 B (290.7 MiB), of which 267,084,660 B was `.so` files and only 81,671,640 B of that
was the `arm64-v8a` slice, so dropping the other three ABIs (~185 MB of native libraries) is expected to
leave an APK around 120 MB — CI's emitted APK is the authority for the real number. Trade-off: the APK
will not install on an x86_64 emulator (`INSTALL_FAILED_NO_MATCHING_ABIS`). For emulator work, use an
`arm64-v8a` system image, or temporarily add `x86_64` to both `reactNativeArchitectures` and
`abiFilters` and rebuild — and drop it again before shipping a device APK.
