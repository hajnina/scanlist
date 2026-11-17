# ScanList — React Native app

Build, test and packaging notes: [`BUILD.md`](BUILD.md).

## Device APKs are arm64-v8a only

`android/app/build.gradle` pins `ndk { abiFilters 'arm64-v8a' }`, so debug and release APKs contain
native libraries for 64-bit ARM phones only (the four-ABI build was ~304 MB, of which ~267 MB was
`x86`/`x86_64`/`armeabi-v7a` copies no phone uses). Trade-off: the APK will not install on an
x86_64 emulator (`INSTALL_FAILED_NO_MATCHING_ABIS`). For emulator work, use an `arm64-v8a` system
image, or temporarily add `x86_64` to the `abiFilters` list and rebuild — and drop it again before
shipping a device APK.
